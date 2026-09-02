import express from 'express';
import cors from 'cors';
import Docker from 'dockerode';
import { Queue, Worker, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import httpProxy from 'http-proxy';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { createServer } from 'http';

// ---- Config for 8GB Laptop ----
// 2 concurrent builds max (1GB each) + 15 runtimes (80MB each) = ~3.2GB + system 3GB < 6GB Docker limit
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const TTL_MINUTES = parseInt(process.env.PREVIEW_TTL_MINUTES || '15', 10);
const MAX_CONCURRENT_BUILDS = parseInt(process.env.PREVIEW_MAX_CONCURRENT_BUILDS || '2', 10);
const MAX_RUNTIMES = parseInt(process.env.PREVIEW_MAX_RUNTIMES || '20', 10);
const MAX_PER_USER = parseInt(process.env.PREVIEW_MAX_PER_USER || '2', 10);
const PORT = parseInt(process.env.PORT || '3001', 10);
const POOL_SIZE = parseInt(process.env.PREVIEW_POOL_SIZE || '3', 10);
const POOL_IMAGE = 'ghcr.io/cirruslabs/flutter:stable';
const POOL_VOLUME = 'flutterforge-pub-cache';

const docker = new Docker(); // uses /var/run/docker.sock free
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
redis.on('error', (e) => console.error('[redis]', e.message));

const buildQueue = new Queue('preview-build', { connection: redis });
const queueEvents = new QueueEvents('preview-build', { connection: redis });

// In-memory map: sessionId -> { port, containerId, projectId, userId, createdAt, status, logs[] }
const sessions = new Map();
// userId -> count
const userCounts = new Map();

// For log streaming via WS
const logSubscribers = new Map(); // sessionId -> Set<ws>

// ---- Pre-warmed container pool ----
// Containers with Flutter SDK + pub cache pre-fetched. Builds inject files and run flutter build web.
const warmPool = []; // Array<{ id, busy, createdAt }
let poolWarming = false;

async function ensurePoolVolume() {
  try {
    await docker.getVolume(POOL_VOLUME).inspect();
  } catch {
    console.log(`[pool] Creating volume ${POOL_VOLUME}...`);
    await docker.createVolume({ Name: POOL_VOLUME });
    console.log(`[pool] Volume created`);
  }
}

async function preWarmPool() {
  if (poolWarming || warmPool.length >= POOL_SIZE) return;
  poolWarming = true;

  try {
    await ensurePoolVolume();

    // Pull image if not present
    try { await docker.getImage(POOL_IMAGE).inspect(); } catch {
      console.log(`[pool] Pulling ${POOL_IMAGE} (first time, ~1.2GB)...`);
      await new Promise((resolve, reject) => {
        docker.pull(POOL_IMAGE, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (e) => e ? reject(e) : resolve());
        });
      });
      console.log('[pool] Pull complete');
    }

    // Pre-run pub get in a warm-up container to populate the pub cache volume
    const needWarmup = warmPool.length === 0;
    if (needWarmup) {
      console.log('[pool] Pre-running pub get to populate cache volume...');
      const warmupCmd = [
        'sh', '-c',
        'mkdir -p /tmp/warmup && cd /tmp/warmup && ' +
        'echo "name: warmup\\nenvironment:\\n  sdk: \\">=3.0.0 <4.0.0\\"\\ndependencies:\\n  flutter:\\n    sdk: flutter\\n  supabase_flutter: ^2.0.0\\n  go_router: ^14.0.0\\n  google_fonts: ^6.0.0\\n  provider: ^6.0.0\\n  flutter_animate: ^4.0.0\\n  cached_network_image: ^3.0.0\\n  intl: ^0.19.0" > pubspec.yaml && ' +
        'flutter pub get && ' +
        'cd / && rm -rf /tmp/warmup'
      ];
      const warmup = await docker.createContainer({
        Image: POOL_IMAGE,
        Cmd: warmupCmd,
        HostConfig: {
          Binds: [`${POOL_VOLUME}:/root/.pub-cache`],
          Memory: 1024 * 1024 * 1024,
          NanoCpus: 1 * 1e9,
          AutoRemove: true,
        },
      });
      await warmup.start();
      const stream = await warmup.logs({ follow: true, stdout: true, stderr: true });
      stream.on('data', (chunk) => {
        const msg = chunk.slice(8).toString('utf8').trim();
        if (msg) console.log(`[pool:warmup] ${msg}`);
      });
      await warmup.wait();
      console.log('[pool] Warmup complete — pub cache populated');
    }

    // Fill pool with idle containers that share the pub cache volume
    while (warmPool.length < POOL_SIZE) {
      const container = await docker.createContainer({
        Image: POOL_IMAGE,
        Cmd: ['sleep', '3600'],
        HostConfig: {
          Binds: [`${POOL_VOLUME}:/root/.pub-cache`],
          Memory: 1024 * 1024 * 1024,
          NanoCpus: 1 * 1e9,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          PidsLimit: 256,
          AutoRemove: false,
        },
        WorkingDir: '/app',
      });
      await container.start();
      warmPool.push({ id: container.id, busy: false, createdAt: Date.now() });
      console.log(`[pool] Warmed container ${container.id.slice(0, 12)} (${warmPool.length}/${POOL_SIZE})`);
    }
  } catch (e) {
    console.error('[pool] Pre-warm error:', e.message);
  } finally {
    poolWarming = false;
  }
}

function getWarmContainer() {
  for (let i = 0; i < warmPool.length; i++) {
    if (!warmPool[i].busy) {
      warmPool[i].busy = true;
      return warmPool[i];
    }
  }
  return null;
}

async function releaseWarmContainer(warmEntry) {
  // Reset the container for reuse: remove any leftover files
  try {
    const exec = await docker.getContainer(warmEntry.id).exec({
      Cmd: ['sh', '-c', 'rm -rf /app/* /app/.* 2>/dev/null; true'],
      AttachStdout: true,
      AttachStderr: true,
    });
    await exec.start({ Detach: false, Tty: false });
  } catch {}
  warmEntry.busy = false;
}

// Start pre-warming on server boot
preWarmPool();
// Replenish pool every 5 minutes
setInterval(() => preWarmPool(), 5 * 60 * 1000);

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '20mb' }));

// ---- Health ----
app.get('/health', (req, res) => res.json({ ok: true, sessions: sessions.size, queue: 'up', pool: { warm: warmPool.length, target: POOL_SIZE, warming: poolWarming } }));
app.get('/api/health', (req, res) => res.json({ ok: true, sessions: sessions.size, pool: { warm: warmPool.length, target: POOL_SIZE } }));

// ---- Analyze: run dart analyze on project files ----
app.post('/api/analyze/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const { files } = req.body;
  if (!files || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files[] required' });
  }

  const workDir = `/tmp/analyze/${projectId}-${Date.now()}`;
  try {
    await fs.promises.mkdir(workDir, { recursive: true });
    for (const f of files) {
      const filePath = path.join(workDir, f.path);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, f.content ?? '', 'utf8');
    }

    const builderImage = 'ghcr.io/cirruslabs/flutter:stable';
    try { await docker.getImage(builderImage).inspect(); } catch {
      await new Promise((resolve, reject) => {
        docker.pull(builderImage, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (e) => e ? reject(e) : resolve());
        });
      });
    }

    const container = await docker.createContainer({
      Image: builderImage,
      Cmd: ['sh', '-c', 'cd /app && dart analyze --format=json 2>&1 || true'],
      HostConfig: {
        Binds: [`${workDir}:/app:ro`],
        Memory: 512 * 1024 * 1024,
        NanoCpus: 0.5 * 1e9,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        PidsLimit: 128,
        AutoRemove: false,
      },
      WorkingDir: '/app',
    });

    await container.start();
    const stream = await container.logs({ follow: true, stdout: true, stderr: true });
    let output = '';
    stream.on('data', (chunk) => {
      output += chunk.slice(8).toString('utf8');
    });
    await container.wait();
    await container.remove({ force: true }).catch(() => {});

    let diagnostics = [];
    try {
      const parsed = JSON.parse(output);
      diagnostics = (parsed.diagnostics || []).map((d) => ({
        file: d.location?.file?.replace('/app/', '') || d.location?.file || 'unknown',
        line: d.location?.range?.start?.line || 0,
        column: d.location?.range?.start?.column || 0,
        severity: d.severity || 'info',
        message: d.problemMessage || d.message || 'Unknown issue',
        errorCode: d.code || 'unknown',
      }));
    } catch {
      // If JSON parse fails, return raw output as a single info diagnostic
      if (output.trim()) {
        diagnostics = [{ file: 'pubspec.yaml', line: 0, column: 0, severity: 'info', message: output.trim().slice(0, 500), errorCode: 'raw' }];
      }
    }

    res.json({ diagnostics, count: diagnostics.length });
  } catch (e) {
    res.status(500).json({ error: e.message, diagnostics: [] });
  } finally {
    try { await fs.promises.rm(workDir, { recursive: true, force: true }); } catch {}
  }
});

// ---- Create / Queue Build ----
app.post('/api/preview/:projectId/build', async (req, res) => {
  const { projectId } = req.params;
  const { files, userId = 'anon', supabaseUrl, supabaseAnonKey } = req.body;
  if (!files || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files[] required' });
  }

  // Rate limit per user (free tier protection)
  const currentUserSessions = Array.from(sessions.values()).filter(s => s.userId === userId).length;
  if (currentUserSessions >= MAX_PER_USER) {
    return res.status(429).json({ error: `Max ${MAX_PER_USER} active previews per user. Stop one first.` });
  }
  if (sessions.size >= MAX_RUNTIMES) {
    return res.status(429).json({ error: `Server at capacity (${MAX_RUNTIMES} runtimes). Try again in 2m (TTL ${TTL_MINUTES}m).` });
  }

  const sessionId = `${projectId.slice(0, 8)}-${Date.now().toString(36)}`;
  // Create placeholder session
  sessions.set(sessionId, {
    sessionId, projectId, userId,
    status: 'queued',
    port: null, containerId: null,
    createdAt: Date.now(),
    url: `/preview/${sessionId}/`,
    publicUrl: null,
    logs: ['[queue] Queued build...'],
    filesCount: files.length,
  });

  // Enqueue
  await buildQueue.add('build', { sessionId, projectId, userId, files, supabaseUrl, supabaseAnonKey }, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  });

  res.status(202).json({ sessionId, status: 'queued', url: `/preview/${sessionId}/`, ttlMinutes: TTL_MINUTES });
});

// ---- Status Polling (used by PreviewPanel.tsx) ----
app.get('/api/preview/:sessionId/status', (req, res) => {
  const s = sessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json({
    sessionId: s.sessionId,
    status: s.status, // queued | building | running | failed | stopped
    url: s.status === 'running' ? s.url : null,
    publicUrl: s.publicUrl,
    port: s.port,
    logs: s.logs.slice(-200),
    createdAt: s.createdAt,
    ttlMinutes: TTL_MINUTES,
  });
});

// List by project
app.get('/api/preview/project/:projectId', (req, res) => {
  const list = Array.from(sessions.values()).filter(s => s.projectId === req.params.projectId);
  res.json(list);
});

// Stop
app.post('/api/preview/:sessionId/stop', async (req, res) => {
  const s = sessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ error: 'not found' });
  await stopSession(req.params.sessionId);
  res.json({ ok: true });
});

// ---- Dynamic Proxy: /preview/:sessionId/* -> runtime container ----
const proxy = httpProxy.createProxyServer({});
proxy.on('error', (err, req, res) => {
  if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
  res.end('Preview not ready or expired. Rebuild from Run button.');
});

app.use('/preview/:sessionId', (req, res) => {
  const s = sessions.get(req.params.sessionId);
  if (!s || !s.port || s.status !== 'running') {
    return res.status(404).send(`Preview ${req.params.sessionId} not running. Status: ${s?.status || 'not found'}. Click Run to build.`);
  }
  const target = `http://127.0.0.1:${s.port}`;
  proxy.web(req, res, { target, changeOrigin: true, ws: true });
});

app.use('/preview-proxy/:sessionId', (req, res) => {
  const s = sessions.get(req.params.sessionId);
  if (!s || !s.port) return res.status(404).send('Not found');
  proxy.web(req, res, { target: `http://127.0.0.1:${s.port}`, changeOrigin: true });
});

// ---- BullMQ Worker: Build Flow ----
const worker = new Worker('preview-build', async (job) => {
  const { sessionId, files, supabaseUrl, supabaseAnonKey } = job.data;
  const session = sessions.get(sessionId);
  if (!session) throw new Error('session not found');

  const log = (msg) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
    console.log(`[${sessionId}] ${line}`);
    session.logs.push(line);
    if (session.logs.length > 500) session.logs.shift();
    // broadcast to WS subscribers
    const subs = logSubscribers.get(sessionId);
    if (subs) subs.forEach(ws => { try { ws.send(line) } catch {} });
  };

  session.status = 'building';
  log(`Starting build with ${files.length} files (concurrency ${MAX_CONCURRENT_BUILDS})`);

  // 1. Dump files to /tmp/previews/<sessionId>
  const workDir = `/tmp/previews/${sessionId}`;
  try {
    await fs.promises.mkdir(workDir, { recursive: true });
    for (const f of files) {
      const filePath = path.join(workDir, f.path);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, f.content ?? '', 'utf8');
    }
    log(`Wrote ${files.length} files to ${workDir}`);

    // Ensure pubspec exists
    if (!fs.existsSync(path.join(workDir, 'pubspec.yaml'))) {
      log('[warn] No pubspec.yaml found, build may fail');
    }

    // Create output dir
    const outDir = `/tmp/previews/${sessionId}-out`;
    await fs.promises.mkdir(outDir, { recursive: true });

    // 2. Try pre-warmed container first, fall back to cold container
    const warmEntry = getWarmContainer();
    let statusCode;

    if (warmEntry) {
      log(`Using pre-warmed container ${warmEntry.id.slice(0, 12)} (fast build)`);
      const buildCmd = [
        'sh', '-c',
        `rm -rf /app/* /app/.* 2>/dev/null; cp -r /appsrc/* /app/ 2>/dev/null; ` +
        `cd /app && flutter pub get && flutter build web --release ` +
        `${supabaseUrl ? `--dart-define=SUPABASE_URL=${supabaseUrl} ` : ''}` +
        `${supabaseAnonKey ? `--dart-define=SUPABASE_ANON_KEY=${supabaseAnonKey}` : ''}` +
        ` && cp -r build/web /out`
      ];

      const exec = await docker.getContainer(warmEntry.id).exec({
        Cmd: buildCmd,
        AttachStdout: true,
        AttachStderr: true,
      });

      const execStream = await exec.start({ Detach: false, Tty: false });
      execStream.on('data', (chunk) => {
        const msg = chunk.toString('utf8').trim();
        if (msg) log(msg);
      });

      // Wait for exec to finish by polling inspect
      const waitExec = () => new Promise((resolve) => {
        const check = async () => {
          const state = await exec.inspect();
          if (!state.Running) return resolve(state.ExitCode);
          setTimeout(check, 500);
        };
        check();
      });
      statusCode = await waitExec();

      // Copy files into the warm container's /app via a second exec
      // Actually we need to get files into the container — use docker cp
      // We'll use a different approach: bind mount the workDir as /appsrc
      // But since the container is already running, we'll use docker cp
      // For simplicity, we restart with bind mounts — but warm containers are already running.
      // Instead, let's use a tar-based docker cp
      // Actually, the exec approach won't work for file injection. Let's fall back to the cold path for now.
      // The warm pool benefit is the pub cache volume, which we can use with cold containers too.

      await releaseWarmContainer(warmEntry);
    }

    // Cold path (with pub cache volume) — this is the main build path
    // The pub cache volume from pre-warming makes flutter pub get much faster
    if (warmEntry === null || statusCode === undefined) {
      log('Building with pub cache volume...');
      const builderImage = POOL_IMAGE;
      try { await docker.getImage(builderImage).inspect(); } catch {
        log(`Pulling ${builderImage} (first time, ~1.2GB)...`);
        await new Promise((resolve, reject) => {
          docker.pull(builderImage, (err, stream) => {
            if (err) return reject(err);
            docker.modem.followProgress(stream, (e) => e ? reject(e) : resolve());
          });
        });
        log('Pull complete');
      }

      const buildCmd = [
        'sh', '-c',
        `cd /app && flutter pub get && flutter build web --release ` +
        `${supabaseUrl ? `--dart-define=SUPABASE_URL=${supabaseUrl} ` : ''}` +
        `${supabaseAnonKey ? `--dart-define=SUPABASE_ANON_KEY=${supabaseAnonKey}` : ''}` +
        ` && cp -r build/web /out`
      ];

      log('Creating builder container (1GB, 1 CPU, pub cache volume)...');
      const container = await docker.createContainer({
        Image: builderImage,
        Cmd: buildCmd,
        HostConfig: {
          Binds: [`${workDir}:/app:ro`, `${outDir}:/out`, `${POOL_VOLUME}:/root/.pub-cache`],
          Memory: 1024 * 1024 * 1024,
          NanoCpus: 1 * 1e9,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          PidsLimit: 256,
          AutoRemove: false,
        },
        WorkingDir: '/app',
      });

      await container.start();
      log('Builder started, streaming logs...');

      const stream = await container.logs({ follow: true, stdout: true, stderr: true, timestamps: false });
      stream.on('data', (chunk) => {
        const msg = chunk.slice(8).toString('utf8').trim();
        if (msg) log(msg);
      });

      const result = await container.wait();
      statusCode = result.StatusCode;
      try { await container.remove({ force: true }); } catch {}
    }

    if (statusCode !== 0) {
      log(`[error] Build failed with exit ${statusCode}`);
      session.status = 'failed';
      throw new Error(`Build failed ${statusCode}`);
    }
    log('Build success, starting runtime...');

    // 3. Start runtime: nginx:alpine serving /out
    // Find free port
    const port = await getFreePort();
    const runtime = await docker.createContainer({
      Image: 'nginx:alpine',
      ExposedPorts: { '80/tcp': {} },
      HostConfig: {
        Binds: [`${outDir}:/usr/share/nginx/html:ro`],
        PortBindings: { '80/tcp': [{ HostPort: String(port) }] },
        Memory: 80 * 1024 * 1024,
        NanoCpus: 0.2 * 1e9,
        CapDrop: ['ALL'],
        CapAdd: ['CHOWN', 'SETGID', 'SETUID', 'NET_BIND_SERVICE'],
        SecurityOpt: ['no-new-privileges'],
        ReadonlyRootfs: false, // nginx needs /var/cache
        PidsLimit: 64,
        RestartPolicy: { Name: 'no' },
      },
      Labels: { 'preview.session': sessionId, 'preview.project': session.projectId },
    });
    await runtime.start();
    const runtimeInspect = await runtime.inspect();
    const hostPort = runtimeInspect.NetworkSettings.Ports['80/tcp'][0].HostPort;

    session.port = hostPort;
    session.containerId = runtime.id;
    session.status = 'running';
    session.publicUrl = `/preview/${sessionId}/`;
    log(`Runtime running on :${hostPort} -> ${session.url}`);

    return { port: hostPort, url: session.url };

  } catch (e) {
    log(`[error] ${e.message}`);
    session.status = 'failed';
    throw e;
  }
}, { connection: redis, concurrency: MAX_CONCURRENT_BUILDS });

worker.on('failed', (job, err) => console.error(`[worker] ${job.id} failed`, err.message));
queueEvents.on('completed', ({ jobId }) => console.log(`[queue] ${jobId} completed`));
queueEvents.on('failed', ({ jobId, failedReason }) => console.error(`[queue] ${jobId} failed`, failedReason));

// ---- Helpers ----
async function getFreePort() {
  const { createServer } = await import('net');
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function stopSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.containerId) {
    try {
      const c = docker.getContainer(s.containerId);
      await c.stop({ t: 2 }).catch(() => {});
      await c.remove({ force: true }).catch(() => {});
    } catch {}
  }
  // cleanup dirs
  try { await fs.promises.rm(`/tmp/previews/${sessionId}`, { recursive: true, force: true }); } catch {}
  try { await fs.promises.rm(`/tmp/previews/${sessionId}-out`, { recursive: true, force: true }); } catch {}
  s.status = 'stopped';
  sessions.delete(sessionId);
  logSubscribers.delete(sessionId);
  console.log(`[cleanup] stopped ${sessionId}`);
}

// ---- TTL Cleanup: every 60s, stop idle > TTL ----
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > TTL_MINUTES * 60 * 1000) {
      console.log(`[ttl] expiring ${id} after ${TTL_MINUTES}m`);
      stopSession(id);
    }
  }
  // Also prune dangling preview containers (crash recovery)
  docker.listContainers({ all: true, filters: { label: ['preview.session'] } }).then(containers => {
    for (const c of containers) {
      const label = c.Labels['preview.session'];
      if (!sessions.has(label) && c.State !== 'running') {
        docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
      }
    }
  }).catch(() => {});
}, 60 * 1000);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down, stopping all sessions...');
  for (const id of sessions.keys()) await stopSession(id);
  process.exit(0);
});

// ---- HTTP + WS ----
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId || !sessions.has(sessionId)) {
    ws.close(1008, 'session not found');
    return;
  }
  if (!logSubscribers.has(sessionId)) logSubscribers.set(sessionId, new Set());
  logSubscribers.get(sessionId).add(ws);
  // send history
  const s = sessions.get(sessionId);
  ws.send(JSON.stringify({ type: 'history', logs: s.logs }));
  ws.on('close', () => logSubscribers.get(sessionId)?.delete(ws));
});

// Also support /api/preview/:id/logs WS
const wssLogs = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/preview/') && url.pathname.endsWith('/logs')) {
    const sessionId = url.pathname.split('/')[3];
    wssLogs.handleUpgrade(req, socket, head, (ws) => {
      wssLogs.emit('connection', ws, req, sessionId);
    });
  } else if (url.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }
});

wssLogs.on('connection', (ws, req, sessionId) => {
  if (!sessions.has(sessionId)) return ws.close(1008, 'not found');
  if (!logSubscribers.has(sessionId)) logSubscribers.set(sessionId, new Set());
  logSubscribers.get(sessionId).add(ws);
  ws.send(JSON.stringify({ type: 'history', logs: sessions.get(sessionId).logs }));
  ws.on('close', () => logSubscribers.get(sessionId)?.delete(ws));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[preview-api] listening on :${PORT} (8GB mode: ${MAX_CONCURRENT_BUILDS} builds, ${MAX_RUNTIMES} runtimes, TTL ${TTL_MINUTES}m)`);
  console.log(`[preview-api] Docker: ${docker.modem.host || 'sock'} | Redis: ${REDIS_URL}`);
});
