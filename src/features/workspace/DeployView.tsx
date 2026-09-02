import { Rocket, ExternalLink, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { useState } from 'react';
import { useProjectStore } from '@/stores/project.store';
import { useTerminalStore } from '@/stores/terminal.store';
import { usePreviewStore } from '@/stores/preview.store';
import { toast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';

const PREVIEW_SERVER_URL = import.meta.env.VITE_PREVIEW_SERVER_URL || 'http://localhost:3001';

export function DeployView() {
  const { currentProject, updateProject, deployments, files } = useProjectStore();
  const { setBuilding, addBuildLog, clearBuildLogs } = useTerminalStore();
  const { build, getSession } = usePreviewStore();
  const [deploying, setDeploying] = useState(false);

  if (!currentProject) return null;

  async function handleDeploy() {
    setDeploying(true);
    setBuilding(true);
    clearBuildLogs();
    addBuildLog('$ flutter build web --release');
    addBuildLog('Building for deployment...');

    try {
      const projectFiles = useProjectStore.getState().files
        .filter((f) => !f.is_directory)
        .map((f) => ({ path: f.path, content: f.content }));

      if (projectFiles.length === 0) {
        addBuildLog('[error] No files to deploy');
        toast('error', 'No files found to deploy.');
        setDeploying(false);
        setBuilding(false);
        return;
      }

      const response = await fetch(`${PREVIEW_SERVER_URL}/api/preview/${currentProject!.id}/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: projectFiles,
          userId: 'deploy-' + currentProject!.id.slice(0, 8),
          supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
          supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Build rejected' }));
        addBuildLog(`[error] ${err.error || response.statusText}`);
        toast('error', `Deploy failed: ${err.error || 'Unknown error'}`);
        setDeploying(false);
        setBuilding(false);
        return;
      }

      const data = await response.json() as { sessionId: string; status: string; url: string };
      addBuildLog(`Build queued: ${data.sessionId}`);

      // Poll for build completion
      let buildComplete = false;
      let attempts = 0;
      const maxAttempts = 120;

      while (!buildComplete && attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
        attempts++;

        const statusRes = await fetch(`${PREVIEW_SERVER_URL}/api/preview/${data.sessionId}/status`);
        if (!statusRes.ok) continue;
        const status = await statusRes.json() as { status: string; url: string | null; logs: string[] };

        if (status.logs && status.logs.length > 0) {
          const lastLog = status.logs[status.logs.length - 1];
          if (!addBuildLog.toString().includes(lastLog)) {
            addBuildLog(lastLog);
          }
        }

        if (status.status === 'running' && status.url) {
          buildComplete = true;
          const fullUrl = `${PREVIEW_SERVER_URL}${status.url}`;
          addBuildLog(`✓ Build complete`);
          addBuildLog(`✓ Deployed to ${fullUrl}`);
          await updateProject(currentProject!.id, {
            status: 'deployed',
            deployment_url: fullUrl,
          });
          toast('success', 'Deployed! Your app is live.');
        } else if (status.status === 'failed') {
          buildComplete = true;
          addBuildLog('[error] Build failed on server');
          toast('error', 'Build failed. Check the build logs.');
        }
      }

      if (!buildComplete) {
        addBuildLog('[error] Build timed out after 4 minutes');
        toast('error', 'Deploy timed out. The server may be busy.');
      }
    } catch (e) {
      addBuildLog(`[error] ${(e as Error).message}`);
      toast('error', `Deploy failed: ${(e as Error).message}`);
    } finally {
      setDeploying(false);
      setBuilding(false);
    }
  }

  const latestDeployment = deployments[0];

  return (
    <div className="flex flex-col h-full bg-[var(--ff-bg)] overflow-y-auto ff-scrollbar">
      <div className="max-w-2xl mx-auto w-full p-6 space-y-6">
        <div className="flex items-center gap-2">
          <Rocket size={18} className="text-[var(--ff-primary)]" />
          <h2 className="text-lg font-semibold text-white">Deploy</h2>
        </div>

        {/* Current deployment status */}
        <div className="ff-card p-6 text-center">
          {currentProject.status === 'deployed' && currentProject.deployment_url ? (
            <>
              <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 size={28} className="text-emerald-400" />
              </div>
              <h3 className="text-base font-semibold text-white mb-1">Your app is live</h3>
              <a
                href={currentProject.deployment_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-[var(--ff-primary)] hover:underline mt-2"
              >
                {currentProject.deployment_url}
                <ExternalLink size={12} />
              </a>
              <div className="mt-4">
                <Button variant="outline" size="sm" loading={deploying} onClick={handleDeploy}>
                  Redeploy
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="w-14 h-14 rounded-2xl bg-[var(--ff-primary)]/10 flex items-center justify-center mx-auto mb-4">
                {deploying ? <Loader2 size={28} className="text-[var(--ff-primary)] ff-spin" /> : <Rocket size={28} className="text-[var(--ff-primary)]" />}
              </div>
              <h3 className="text-base font-semibold text-white mb-1">
                {deploying ? 'Deploying...' : 'Deploy your Flutter Web app'}
              </h3>
              <p className="text-sm text-[var(--ff-text-muted)] mt-1 mb-4">
                Get a live URL you can share with anyone. Flutter Web builds run in any browser.
              </p>
              <Button loading={deploying} onClick={handleDeploy} icon={!deploying ? <Rocket size={14} /> : undefined}>
                {deploying ? 'Deploying...' : 'Deploy Now'}
              </Button>
            </>
          )}
        </div>

        {/* Deployments history */}
        {deployments.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-[var(--ff-text-dim)] uppercase tracking-wider mb-3">Deployment History</h3>
            <div className="space-y-2">
              {deployments.map((dep) => (
                <div key={dep.id} className="ff-card p-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-[var(--ff-surface-2)] flex items-center justify-center">
                      <Rocket size={14} className="text-[var(--ff-text-muted)]" />
                    </div>
                    <div>
                      <p className="text-sm text-white font-mono">{dep.url ?? '—'}</p>
                      <p className="text-[10px] text-[var(--ff-text-dim)]">{new Date(dep.created_at).toLocaleString()}</p>
                    </div>
                  </div>
                  <Badge variant={dep.status === 'deployed' ? 'success' : dep.status === 'failed' ? 'error' : 'warning'}>
                    {dep.status}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="ff-card p-4 bg-blue-500/5 border-blue-500/20">
          <p className="text-xs text-[var(--ff-text-muted)] leading-relaxed">
            Deployments use Flutter Web builds hosted on FlutterForge infrastructure. Custom domains and custom deployment targets will be available in a future update.
          </p>
        </div>
      </div>
    </div>
  );
}
