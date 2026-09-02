import { create } from 'zustand';
import type { ProjectFile } from '@/types';

type PreviewStatus = 'idle' | 'building' | 'running' | 'failed' | 'stopped';

interface PreviewSession {
  sessionId: string;
  projectId: string;
  status: PreviewStatus;
  html: string | null;
  logs: string[];
  createdAt: number;
}

interface PreviewState {
  sessions: Record<string, PreviewSession>;
  currentSessionId: string | null;
  isLoading: boolean;
  error: string | null;

  getSession: (projectId: string) => PreviewSession | null;
  getStatus: (projectId: string) => PreviewStatus;

  build: (projectId: string, files: Array<{ path: string; content: string | null }>, opts?: { supabaseUrl?: string; supabaseAnonKey?: string }) => Promise<string>;
  stop: (sessionId: string) => Promise<void>;
  refresh: (projectId: string) => void;
  clearError: () => void;
}

// ── Dart analysis helpers ──────────────────────────────────────────────

interface ParsedScreen {
  name: string;
  title: string;
  widgets: ParsedWidget[];
  hasAppBar: boolean;
  hasFab: boolean;
  appBarActions: string[];
}

interface ParsedWidget {
  type: 'text' | 'input' | 'button' | 'list' | 'card' | 'image' | 'fab' | 'divider' | 'chip' | 'avatar' | 'toggle' | 'slider' | 'tabbar' | 'chart' | 'stat' | 'grid';
  text?: string;
  subtitle?: string;
  itemCount?: number;
  color?: string;
  children?: ParsedWidget[];
  icon?: string;
}

interface ParsedApp {
  appName: string;
  primaryColor: string;
  secondaryColor: string;
  isDark: boolean;
  fontFamily: string;
  screens: ParsedScreen[];
}

function extractColor(code: string, key: string): string | null {
  const patterns = [
    new RegExp(`${key}:\\s*Color\\(0x([0-9A-Fa-f]{8})\\)`),
    new RegExp(`${key}:\\s*Color\\(0xFF([0-9A-Fa-f]{6})\\)`),
    new RegExp(`${key}:\\s*Color\\.fromARGB\\([^)]+\\)`),
    new RegExp(`${key}:\\s*['"]#([0-9A-Fa-f]{6})['"]`),
  ];
  for (const p of patterns) {
    const m = code.match(p);
    if (m) {
      if (m[1]) {
        const hex = m[1].length === 8 ? m[1].slice(2) : m[1];
        return `#${hex}`;
      }
      // fromARGB — try to extract
      const argbMatch = code.match(new RegExp(`${key}:\\s*Color\\.fromARGB\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*(\\d+)\\)`));
      if (argbMatch) {
        const r = parseInt(argbMatch[2]).toString(16).padStart(2, '0');
        const g = parseInt(argbMatch[3]).toString(16).padStart(2, '0');
        const b = parseInt(argbMatch[4]).toString(16).padStart(2, '0');
        return `#${r}${g}${b}`;
      }
    }
  }
  return null;
}

function inferAppType(code: string): string {
  const lower = code.toLowerCase();
  if (/shop|cart|product|order|checkout|ecommerce|store/.test(lower)) return 'ecommerce';
  if (/chat|message|conversation|stream.*response/.test(lower)) return 'chat';
  if (/finance|wallet|transaction|budget|expense|balance/.test(lower)) return 'finance';
  if (/food|restaurant|delivery|menu|order.*food/.test(lower)) return 'food';
  if (/task|todo|kanban|board|project.*manage/.test(lower)) return 'task';
  if (/dashboard|analytics|chart|stat|metric|report/.test(lower)) return 'dashboard';
  if (/social|feed|post|like|comment|follow|profile/.test(lower)) return 'social';
  if (/blog|article|news|post.*content/.test(lower)) return 'blog';
  if (/auth|login|signup|register|onboard/.test(lower)) return 'auth';
  return 'generic';
}

function extractScreensFromDart(dartFiles: Array<{ path: string; content: string }>): ParsedScreen[] {
  const screens: ParsedScreen[] = [];
  const screenFiles = dartFiles.filter(
    (f) => f.path.includes('/screens/') || f.path.includes('/pages/') || f.path.includes('/views/') || f.path === 'lib/main.dart'
  );

  for (const file of screenFiles) {
    const content = file.content;
    const rawName = file.path.split('/').pop()?.replace('_screen.dart', '').replace('_page.dart', '').replace('_view.dart', '').replace('.dart', '') || 'Screen';
    const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);

    const appBarMatch = content.match(/AppBar[\s\S]*?title:\s*Text\(\s*['"]([^'"]+)['"]/);
    const title = appBarMatch?.[1] || name;

    const hasAppBar = /AppBar\(/.test(content);
    const hasFab = /FloatingActionButton\(/.test(content);

    const actionMatches = [...content.matchAll(/IconButton\([\s\S]*?icon:\s*Icon\(\s*Icons\.(\w+)\)/g)];
    const appBarActions = actionMatches.map((m) => m[1]).slice(0, 3);

    const widgets = extractWidgetsFromCode(content);
    screens.push({ name, title, widgets, hasAppBar, hasFab, appBarActions });
  }

  return screens;
}

function extractWidgetsFromCode(code: string): ParsedWidget[] {
  const widgets: ParsedWidget[] = [];

  // AppBar title
  const appBarTitle = code.match(/AppBar[\s\S]*?title:\s*Text\(\s*['"]([^'"]+)['"]/);
  if (appBarTitle) {
    widgets.push({ type: 'text', text: appBarTitle[1] });
  }

  // Headline / title text (larger fonts)
  const headlineMatch = code.match(/Text\(\s*['"]([^'"]+)['"]\s*,?\s*style:\s*TextStyle[\s\S]*?fontSize:\s*(?:3[0-9]|2[5-9])/);
  if (headlineMatch) {
    widgets.push({ type: 'text', text: headlineMatch[1] });
  }

  // All Text widgets
  const textMatches = [...code.matchAll(/Text\(\s*['"]([^'"]{2,})['"]/g)];
  const seen = new Set<string>();
  for (const m of textMatches) {
    if (!seen.has(m[1]) && m[1].length > 2) {
      seen.add(m[1]);
      // Check if it's a subtitle (has fontSize < 16 nearby)
      const isSmall = /style:\s*TextStyle[\s\S]*?fontSize:\s*1[0-5]/.test(
        code.slice(m.index!, m.index! + 200)
      );
      widgets.push({ type: 'text', text: m[1], subtitle: isSmall ? 'small' : undefined });
    }
  }

  // TextFields
  const inputMatches = [...code.matchAll(/TextFormField\([\s\S]*?hintText:\s*['"]([^'"]+)['"]/g)];
  if (inputMatches.length > 0) {
    for (const m of inputMatches) {
      widgets.push({ type: 'input', text: m[1] });
    }
  } else if (/TextField|TextFormField|TextInput/i.test(code)) {
    const hintMatch = code.match(/hintText:\s*['"]([^'"]+)['"]/);
    widgets.push({ type: 'input', text: hintMatch?.[1] || 'Enter text...' });
  }

  // Buttons
  const buttonMatches = [...code.matchAll(/(?:ElevatedButton|FilledButton|RaisedButton)\([\s\S]*?child:\s*Text\(\s*['"]([^'"]+)['"]/g)];
  if (buttonMatches.length > 0) {
    for (const m of buttonMatches) {
      widgets.push({ type: 'button', text: m[1] });
    }
  } else if (/ElevatedButton|FilledButton|RaisedButton|TextButton/i.test(code)) {
    widgets.push({ type: 'button', text: 'Submit' });
  }

  // ListViews
  if (/ListView|GridView|StaggeredGrid/i.test(code)) {
    const countMatch = code.match(/itemCount:\s*(\d+)/);
    const isGrid = /GridView/.test(code);
    widgets.push({ type: isGrid ? 'grid' : 'list', itemCount: parseInt(countMatch?.[1] || '8') });
  }

  // Cards with content
  if (/Card\(/.test(code)) {
    widgets.push({ type: 'card' });
  }

  // Images
  if (/NetworkImage|Image\.network|AsyncImage|Image\.asset|CachedNetworkImage/i.test(code)) {
    widgets.push({ type: 'image' });
  }

  // Charts
  if (/LineChart|BarChart|PieChart|fl_chart|charts_flutter|ChartWidget/i.test(code)) {
    widgets.push({ type: 'chart' });
  }

  // Stats / metrics
  if (/\b(?:stat|metric|count|total|balance|score|rating)\b/i.test(code) && /\d/.test(code)) {
    widgets.push({ type: 'stat' });
  }

  // Chips
  if (/Chip\(|FilterChip\(|ChoiceChip\(|ActionChip\(/.test(code)) {
    const chipMatch = code.match(/Chip\([\s\S]*?label:\s*Text\(\s*['"]([^'"]+)['"]/);
    widgets.push({ type: 'chip', text: chipMatch?.[1] || 'Filter' });
  }

  // Toggles / Switches
  if (/Switch\(|SwitchListTile\(/.test(code)) {
    widgets.push({ type: 'toggle', text: 'Enable' });
  }

  // Sliders
  if (/Slider\(|RangeSlider\(/.test(code)) {
    widgets.push({ type: 'slider' });
  }

  // TabBar
  if (/TabBar\(/.test(code)) {
    const tabMatches = [...code.matchAll(/Tab\(\s*(?:text:\s*['"]([^'"]+)['"]|child:\s*Text\(\s*['"]([^'"]+)['"]\))/g)];
    const tabs = tabMatches.map((m) => m[1] || m[2]).filter(Boolean);
    widgets.push({ type: 'tabbar', children: tabs.map((t) => ({ type: 'text' as const, text: t })) });
  }

  // Dividers
  if (/Divider\(/.test(code)) {
    widgets.push({ type: 'divider' });
  }

  // Avatars / CircleAvatar
  if (/CircleAvatar\(/.test(code)) {
    widgets.push({ type: 'avatar' });
  }

  return widgets.length > 0 ? widgets : [{ type: 'text', text: 'Welcome' }];
}

function parseDartProject(files: Array<{ path: string; content: string | null }>): ParsedApp {
  const dartFiles = files
    .filter((f) => f.path.endsWith('.dart') && f.content)
    .map((f) => ({ path: f.path, content: f.content! }));

  const combined = dartFiles.map((f) => f.content).join('\n');

  const appNameMatch = combined.match(/title:\s*['"]([^'"]+)['"]/);
  const appName = appNameMatch?.[1] || 'Flutter App';

  const primaryColor = extractColor(combined, 'primaryColor') || extractColor(combined, 'seedColor') || '#3B82F6';
  const secondaryColor = extractColor(combined, 'secondaryColor') || '#10B981';
  const isDark = /brightness:\s*Brightness\.dark|ThemeData\.dark|darkTheme/i.test(combined);

  const screens = extractScreensFromDart(dartFiles);
  if (screens.length === 0) {
    // Try to infer from GoRouter routes
    const routeMatches = [...combined.matchAll(/GoRoute\([\s\S]*?name:\s*['"]([^'"]+)['"]/g)];
    if (routeMatches.length > 0) {
      for (const m of routeMatches) {
        const name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
        screens.push({ name, title: name, widgets: extractWidgetsFromCode(combined), hasAppBar: true, hasFab: false, appBarActions: [] });
      }
    }
  }
  if (screens.length === 0) {
    screens.push({ name: 'Home', title: appName, widgets: extractWidgetsFromCode(combined), hasAppBar: true, hasFab: false, appBarActions: [] });
  }

  return { appName, primaryColor, secondaryColor, isDark, fontFamily: 'Inter', screens };
}

// ── HTML generation ────────────────────────────────────────────────────

function generatePreviewHTML(
  files: Array<{ path: string; content: string | null }>,
  opts?: { supabaseUrl?: string; supabaseAnonKey?: string },
): string {
  const fileMap = new Map<string, string>();
  for (const f of files) {
    if (f.content) fileMap.set(f.path, f.content);
  }

  // If preview/index.html exists, use it directly
  const indexHtml = fileMap.get('preview/index.html') || fileMap.get('index.html') || fileMap.get('public/index.html');
  if (indexHtml) {
    let html = indexHtml;
    // Inject Supabase env
    if (opts?.supabaseUrl && opts?.supabaseAnonKey) {
      html = html.replace('</head>', `<script>window.SUPABASE_URL="${opts.supabaseUrl}";window.SUPABASE_ANON_KEY="${opts.supabaseAnonKey}";</script>\n</head>`);
    }
    return html;
  }

  // Fallback: generate from Dart analysis
  const parsed = parseDartProject(files);
  const appType = inferAppType(parsed.screens.map((s) => s.widgets.map((w) => w.text || '').join(' ')).join(' ') + parsed.appName);
  return buildFallbackHTML(parsed, appType, opts);
}

function buildFallbackHTML(
  app: ParsedApp,
  appType: string,
  opts?: { supabaseUrl?: string; supabaseAnonKey?: string },
): string {
  const { primaryColor: pc, secondaryColor: sc, isDark, screens, appName } = app;
  const bg = isDark ? '#0f1117' : '#f8fafc';
  const cardBg = isDark ? '#1e1e2e' : '#ffffff';
  const textColor = isDark ? '#f1f5f9' : '#0f172a';
  const muted = isDark ? '#94a3b8' : '#64748b';
  const border = isDark ? '#334155' : '#e2e8f0';

  const supabaseScript = opts?.supabaseUrl && opts?.supabaseAnonKey
    ? `<script>window.SUPABASE_URL="${opts.supabaseUrl}";window.SUPABASE_ANON_KEY="${opts.supabaseAnonKey}";</script>`
    : '';

  // Generate mock data based on app type
  const mockData = generateMockData(appType);

  // Generate screen HTML
  const screenSections = screens.map((s, i) => `
    <div class="screen ${i === 0 ? 'active' : ''}" data-screen="${i}">
      ${renderScreenHTML(s, i, app, appType, mockData, { bg, cardBg, textColor, muted, border, pc, sc })}
    </div>`).join('');

  const navItems = screens.map((s, i) => `
    <button class="nav-btn ${i === 0 ? 'active' : ''}" data-screen="${i}" onclick="switchScreen(${i})">
      <div class="nav-icon">${getNavIcon(s.name, i, pc)}</div>
      <span class="nav-label">${s.name}</span>
    </button>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>${appName}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif}
:root{--pc:${pc};--sc:${sc};--bg:${bg};--card:${cardBg};--text:${textColor};--muted:${muted};--border:${border}}
body{background:var(--bg);color:var(--text);overflow:hidden;height:100vh}
.screen{display:none;height:calc(100vh - 0px);overflow-y:auto;-webkit-overflow-scrolling:touch;animation:fadeIn .3s ease}
.screen.active{display:flex;flex-direction:column}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes slideUp{from{transform:translateY(100%);opacity:0}to{transform:translateY(0);opacity:1}}
.app-bar{background:var(--pc);color:#fff;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;box-shadow:0 2px 12px rgba(0,0,0,.08)}
.app-bar h1{font-size:15px;font-weight:800;letter-spacing:-.3px}
.app-bar .actions{display:flex;gap:4px}
.app-bar .action-btn{width:32px;height:32px;border-radius:8px;background:rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:14px;cursor:pointer;transition:.2s}
.app-bar .action-btn:hover{background:rgba(255,255,255,.25)}
.content{padding:12px;flex:1;display:flex;flex-direction:column;gap:10px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px;transition:.2s}
.card:hover{border-color:var(--pc);box-shadow:0 4px 16px rgba(0,0,0,.06)}
.card-title{font-size:12px;font-weight:700;margin-bottom:6px}
.card-subtitle{font-size:10px;color:var(--muted);font-weight:500}
.list-item{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px;display:flex;align-items:center;gap:12px;transition:.2s;cursor:pointer}
.list-item:hover{border-color:var(--pc);transform:translateX(2px)}
.list-item .thumb{width:44px;height:44px;border-radius:10px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:18px}
.list-item .info{flex:1;min-width:0}
.list-item .title{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.list-item .subtitle{font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.list-item .trailing{font-size:11px;font-weight:700;color:var(--pc)}
.input-field{background:var(--card);border:1.5px solid var(--border);border-radius:12px;padding:12px 14px;display:flex;align-items:center;gap:10px;transition:.2s}
.input-field:focus-within{border-color:var(--pc)}
.input-field input{border:none;outline:none;background:transparent;font-size:12px;color:var(--text);flex:1;font-family:inherit}
.input-field .icon{color:var(--muted);font-size:14px}
.btn{width:100%;padding:12px;border-radius:12px;background:var(--pc);color:#fff;border:none;font-size:13px;font-weight:700;cursor:pointer;transition:.2s;box-shadow:0 4px 12px ${pc}40}
.btn:hover{filter:brightness(1.08);transform:translateY(-1px)}
.btn:active{transform:translateY(0)}
.btn-outline{background:transparent;color:var(--pc);border:1.5px solid var(--pc);box-shadow:none}
.text-lg{font-size:15px;font-weight:800;letter-spacing:-.3px}
.text-md{font-size:13px;font-weight:700}
.text-sm{font-size:11px;font-weight:600;color:var(--muted)}
.text-xs{font-size:10px;color:var(--muted)}
.chip{display:inline-flex;align-items:center;padding:4px 10px;border-radius:20px;font-size:10px;font-weight:600;gap:4px}
.chip-primary{background:${pc}20;color:var(--pc)}
.chip-success{background:#10B98120;color:#10B981}
.chip-warning{background:#F59E0B20;color:#F59E0B}
.chip-neutral{background:var(--border);color:var(--muted)}
.stat-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:4px}
.stat-value{font-size:20px;font-weight:800;letter-spacing:-.5px}
.stat-label{font-size:10px;color:var(--muted);font-weight:500}
.stat-trend{font-size:10px;font-weight:700;display:flex;align-items:center;gap:2px}
.stat-trend.up{color:#10B981}
.stat-trend.down{color:#EF4444}
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.chart-container{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px}
.chart-bars{display:flex;align-items:flex-end;gap:6px;height:80px;margin-top:8px}
.chart-bar{flex:1;border-radius:4px 4px 0 0;background:linear-gradient(to top,var(--pc),${pc}80);transition:.3s;min-height:4px;position:relative}
.chart-bar:hover{filter:brightness(1.1)}
.grid-view{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.grid-item{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;cursor:pointer;transition:.2s}
.grid-item:hover{border-color:var(--pc);transform:scale(1.02)}
.grid-item .img{height:80px;background:linear-gradient(135deg,${pc}30,${sc}30);display:flex;align-items:center;justify-content:center;font-size:24px}
.grid-item .body{padding:10px}
.grid-item .title{font-size:11px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.grid-item .price{font-size:12px;font-weight:800;color:var(--pc);margin-top:2px}
.fab{position:fixed;bottom:80px;right:16px;width:52px;height:52px;border-radius:50%;background:var(--pc);color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:300;box-shadow:0 6px 20px ${pc}50;cursor:pointer;z-index:20;transition:.2s}
.fab:hover{transform:scale(1.08)}
.fab:active{transform:scale(.95)}
.bottom-nav{position:fixed;bottom:0;left:0;right:0;display:flex;background:var(--card);border-top:1px solid var(--border);padding:6px 0 10px;z-index:15;backdrop-filter:blur(10px)}
.nav-btn{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;background:none;border:none;cursor:pointer;padding:4px}
.nav-icon{width:24px;height:24px;display:flex;align-items:center;justify-content:center;transition:.2s}
.nav-label{font-size:9px;font-weight:600;color:var(--muted)}
.nav-btn.active .nav-label{color:var(--pc);font-weight:700}
.nav-btn.active .nav-icon{transform:translateY(-2px)}
.divider{height:1px;background:var(--border);margin:4px 0}
.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--card);border:1px solid var(--border);border-radius:12px}
.toggle{width:40px;height:22px;border-radius:11px;background:var(--border);position:relative;cursor:pointer;transition:.2s}
.toggle.on{background:var(--pc)}
.toggle .knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.2s}
.toggle.on .knob{left:20px}
.slider-row{padding:12px 14px;background:var(--card);border:1px solid var(--border);border-radius:12px}
.slider-track{height:4px;border-radius:2px;background:var(--border);margin-top:8px;position:relative}
.slider-fill{height:100%;border-radius:2px;background:var(--pc);width:60%}
.slider-thumb{position:absolute;top:-6px;left:60%;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.2);transform:translateX(-50%)}
.tab-bar{display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:10px}
.tab-item{padding:8px 14px;font-size:11px;font-weight:600;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;transition:.2s}
.tab-item.active{color:var(--pc);border-bottom-color:var(--pc)}
.chat-msg{display:flex;gap:8px;margin-bottom:8px}
.chat-msg.user{flex-direction:row-reverse}
.chat-bubble{max-width:75%;padding:10px 12px;border-radius:14px;font-size:11px;line-height:1.5}
.chat-msg.ai .chat-bubble{background:var(--card);border:1px solid var(--border);border-bottom-left-radius:4px}
.chat-msg.user .chat-bubble{background:var(--pc);color:#fff;border-bottom-right-radius:4px}
.chat-input{display:flex;gap:8px;padding:10px;background:var(--card);border-top:1px solid var(--border)}
.chat-input input{flex:1;border:1px solid var(--border);border-radius:20px;padding:8px 12px;font-size:11px;outline:none;background:var(--bg);color:var(--text)}
.chat-input button{width:36px;height:36px;border-radius:50%;background:var(--pc);color:#fff;border:none;cursor:pointer;font-size:14px;flex-shrink:0}
.avatar{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--pc),var(--sc));display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:700;flex-shrink:0}
.skeleton{background:linear-gradient(90deg,var(--border) 25%,var(--card) 50%,var(--border) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:8px}
.status-bar{display:flex;justify-content:space-between;padding:6px 16px 2px;font-size:10px;font-weight:700;background:var(--bg);color:var(--text)}
.section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.section-header h2{font-size:14px;font-weight:800}
.section-header .link{font-size:10px;color:var(--pc);font-weight:600;cursor:pointer}
.scroll-content{padding-bottom:80px}
.hero-banner{background:linear-gradient(135deg,var(--pc),var(--sc));border-radius:16px;padding:16px;color:#fff;position:relative;overflow:hidden}
.hero-banner h2{font-size:16px;font-weight:800}
.hero-banner p{font-size:11px;opacity:.9;margin-top:4px}
.hero-banner .deco{position:absolute;right:-20px;bottom:-20px;width:80px;height:80px;border-radius:50%;background:rgba(255,255,255,.1)}
.search-bar{display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--card);border:1px solid var(--border);border-radius:12px}
.search-bar input{border:none;outline:none;background:transparent;font-size:12px;color:var(--text);flex:1;font-family:inherit}
.search-bar .icon{color:var(--muted)}
</style>
${supabaseScript}
</head>
<body>
<div class="status-bar"><span>9:41</span><span>● ● ●</span></div>
${screenSections}
<div class="bottom-nav">${navItems}</div>
<script>
function switchScreen(idx){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.querySelector('.screen[data-screen="'+idx+'"]').classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  document.querySelector('.nav-btn[data-screen="'+idx+'"]').classList.add('active');
}
function toggleSwitch(el){el.classList.toggle('on')}
function sendChat(btn){
  var input=btn.previousElementSibling;var msg=input.value.trim();if(!msg)return;
  var container=btn.closest('.screen').querySelector('.chat-container');
  var userDiv=document.createElement('div');userDiv.className='chat-msg user';
  userDiv.innerHTML='<div class="chat-bubble">'+msg+'</div>';
  container.appendChild(userDiv);input.value='';container.scrollTop=container.scrollHeight;
  setTimeout(function(){
    var aiDiv=document.createElement('div');aiDiv.className='chat-msg ai';
    aiDiv.innerHTML='<div class="avatar">AI</div><div class="chat-bubble">Thanks for your message! This is a preview response. In the real app, this would connect to your AI backend.</div>';
    container.appendChild(aiDiv);container.scrollTop=container.scrollHeight;
  },600);
}
</script>
</body>
</html>`;
}

function getNavIcon(name: string, index: number, color: string): string {
  const icons = ['🏠', '🔍', '🛒', '👤', '📊', '⚙️', '💬', '📁'];
  const lower = name.toLowerCase();
  if (lower.includes('home') || lower.includes('dash')) return icons[0];
  if (lower.includes('search') || lower.includes('explore')) return icons[1];
  if (lower.includes('cart') || lower.includes('shop') || lower.includes('order')) return icons[2];
  if (lower.includes('profile') || lower.includes('account') || lower.includes('setting')) return icons[3];
  if (lower.includes('chart') || lower.includes('analytics') || lower.includes('stat')) return icons[4];
  if (lower.includes('chat') || lower.includes('message')) return icons[6];
  return icons[index % icons.length];
}

function generateMockData(appType: string): {
  listItems: Array<{ title: string; subtitle: string; trailing: string; emoji: string; color: string }>;
  stats: Array<{ label: string; value: string; trend: string; trendUp: boolean }>;
  gridItems: Array<{ title: string; price: string; emoji: string }>;
  chartBars: number[];
} {
  const listColors = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899'];

  switch (appType) {
    case 'ecommerce':
      return {
        listItems: [
          { title: 'Wireless Headphones', subtitle: 'Premium sound quality', trailing: '$199', emoji: '🎧', color: listColors[0] },
          { title: 'Smart Watch Pro', subtitle: 'Fitness + health tracking', trailing: '$299', emoji: '⌚', color: listColors[1] },
          { title: 'Coffee Maker Deluxe', subtitle: 'Brew perfect coffee', trailing: '$89', emoji: '☕', color: listColors[2] },
          { title: 'Running Shoes Air', subtitle: 'Lightweight comfort', trailing: '$129', emoji: '👟', color: listColors[3] },
          { title: 'Desk Lamp LED', subtitle: 'Adjustable brightness', trailing: '$49', emoji: '💡', color: listColors[4] },
          { title: 'Bluetooth Speaker', subtitle: 'Waterproof portable', trailing: '$79', emoji: '🔊', color: listColors[5] },
        ],
        stats: [
          { label: 'Total Sales', value: '$12,430', trend: '+18%', trendUp: true },
          { label: 'Orders', value: '248', trend: '+12%', trendUp: true },
          { label: 'Visitors', value: '8.2K', trend: '+5%', trendUp: true },
          { label: 'Avg Order', value: '$50', trend: '-2%', trendUp: false },
        ],
        gridItems: [
          { title: 'T-Shirt', price: '$25', emoji: '👕' },
          { title: 'Backpack', price: '$45', emoji: '🎒' },
          { title: 'Sunglasses', price: '$30', emoji: '🕶️' },
          { title: 'Water Bottle', price: '$15', emoji: '🥤' },
        ],
        chartBars: [40, 65, 45, 80, 55, 90, 70],
      };
    case 'finance':
      return {
        listItems: [
          { title: 'Grocery Store', subtitle: 'Today, 2:30 PM', trailing: '-$52.30', emoji: '🛒', color: listColors[2] },
          { title: 'Salary Deposit', subtitle: 'Yesterday', trailing: '+$3,200', emoji: '💰', color: listColors[1] },
          { title: 'Electric Bill', subtitle: 'Mar 15', trailing: '-$85.00', emoji: '⚡', color: listColors[3] },
          { title: 'Netflix', subtitle: 'Mar 12', trailing: '-$15.99', emoji: '📺', color: listColors[0] },
          { title: 'Gas Station', subtitle: 'Mar 10', trailing: '-$40.00', emoji: '⛽', color: listColors[5] },
          { title: 'Restaurant', subtitle: 'Mar 8', trailing: '-$67.50', emoji: '🍽️', color: listColors[2] },
        ],
        stats: [
          { label: 'Balance', value: '$8,420', trend: '+8%', trendUp: true },
          { label: 'Income', value: '$3,200', trend: '+15%', trendUp: true },
          { label: 'Expenses', value: '$1,240', trend: '-5%', trendUp: false },
          { label: 'Savings', value: '$2,100', trend: '+22%', trendUp: true },
        ],
        gridItems: [
          { title: 'Food', price: '$320', emoji: '🍔' },
          { title: 'Transport', price: '$180', emoji: '🚗' },
          { title: 'Shopping', price: '$240', emoji: '🛍️' },
          { title: 'Bills', price: '$500', emoji: '📄' },
        ],
        chartBars: [60, 45, 70, 35, 55, 40, 65],
      };
    case 'chat':
      return {
        listItems: [
          { title: 'AI Assistant', subtitle: 'How can I help you today?', trailing: '2m', emoji: '🤖', color: listColors[0] },
          { title: 'Team Channel', subtitle: 'Meeting at 3pm', trailing: '15m', emoji: '👥', color: listColors[1] },
          { title: 'Support Bot', subtitle: 'Your ticket was resolved', trailing: '1h', emoji: '💬', color: listColors[2] },
          { title: 'John Doe', subtitle: 'Did you see the file?', trailing: '3h', emoji: '👨', color: listColors[3] },
          { title: 'Project Group', subtitle: 'Sprint review notes', trailing: '5h', emoji: '📋', color: listColors[4] },
          { title: 'Announcements', subtitle: 'New feature released!', trailing: '1d', emoji: '📢', color: listColors[5] },
        ],
        stats: [
          { label: 'Messages', value: '1,247', trend: '+8%', trendUp: true },
          { label: 'Active Chats', value: '12', trend: '+3', trendUp: true },
          { label: 'Unread', value: '5', trend: '-2', trendUp: false },
          { label: 'Response Time', value: '2.1m', trend: '-15%', trendUp: true },
        ],
        gridItems: [
          { title: 'Direct', price: '8', emoji: '💬' },
          { title: 'Groups', price: '4', emoji: '👥' },
          { title: 'Channels', price: '3', emoji: '📢' },
          { title: 'Archived', price: '12', emoji: '📦' },
        ],
        chartBars: [30, 50, 45, 70, 60, 80, 55],
      };
    case 'food':
      return {
        listItems: [
          { title: 'Burger Palace', subtitle: '0.5 mi · 4.8★ · 20 min', trailing: '$$', emoji: '🍔', color: listColors[3] },
          { title: 'Sushi World', subtitle: '1.2 mi · 4.9★ · 30 min', trailing: '$$$', emoji: '🍣', color: listColors[0] },
          { title: 'Pizza Corner', subtitle: '0.8 mi · 4.5★ · 25 min', trailing: '$$', emoji: '🍕', color: listColors[2] },
          { title: 'Taco Truck', subtitle: '0.3 mi · 4.7★ · 15 min', trailing: '$', emoji: '🌮', color: listColors[1] },
          { title: 'Coffee Lab', subtitle: '0.6 mi · 4.9★ · 10 min', trailing: '$', emoji: '☕', color: listColors[5] },
          { title: 'Salad Bar', subtitle: '1.0 mi · 4.6★ · 20 min', trailing: '$$', emoji: '🥗', color: listColors[4] },
        ],
        stats: [
          { label: 'Orders', value: '24', trend: '+5', trendUp: true },
          { label: 'Spent', value: '$340', trend: '+8%', trendUp: true },
          { label: 'Favorites', value: '8', trend: '+2', trendUp: true },
          { label: 'Reward Pts', value: '1,200', trend: '+120', trendUp: true },
        ],
        gridItems: [
          { title: 'Burger', price: '$12', emoji: '🍔' },
          { title: 'Pizza', price: '$15', emoji: '🍕' },
          { title: 'Sushi', price: '$20', emoji: '🍣' },
          { title: 'Taco', price: '$8', emoji: '🌮' },
        ],
        chartBars: [50, 35, 70, 45, 80, 60, 90],
      };
    case 'task':
      return {
        listItems: [
          { title: 'Design login screen', subtitle: 'High priority · Due today', trailing: 'In Progress', emoji: '🎨', color: listColors[2] },
          { title: 'Fix API pagination bug', subtitle: 'Medium · Due tomorrow', trailing: 'To Do', emoji: '🔧', color: listColors[0] },
          { title: 'Write unit tests', subtitle: 'Low · Due Friday', trailing: 'To Do', emoji: '✅', color: listColors[1] },
          { title: 'Update documentation', subtitle: 'Low · Due next week', trailing: 'Backlog', emoji: '📝', color: listColors[4] },
          { title: 'Code review PR #42', subtitle: 'High · Due today', trailing: 'Review', emoji: '👀', color: listColors[3] },
          { title: 'Deploy to staging', subtitle: 'Medium · Due tomorrow', trailing: 'Blocked', emoji: '🚀', color: listColors[5] },
        ],
        stats: [
          { label: 'Active Tasks', value: '18', trend: '+3', trendUp: true },
          { label: 'Completed', value: '42', trend: '+8', trendUp: true },
          { label: 'Overdue', value: '2', trend: '-1', trendUp: true },
          { label: 'This Week', value: '7', trend: '+2', trendUp: true },
        ],
        gridItems: [
          { title: 'To Do', price: '8', emoji: '📋' },
          { title: 'In Progress', price: '5', emoji: '🔄' },
          { title: 'Review', price: '3', emoji: '👀' },
          { title: 'Done', price: '42', emoji: '✅' },
        ],
        chartBars: [20, 40, 30, 50, 35, 60, 45],
      };
    case 'social':
      return {
        listItems: [
          { title: 'Sarah Chen', subtitle: 'Just posted a new photo', trailing: '5m', emoji: '👩', color: listColors[0] },
          { title: 'Mike Johnson', subtitle: 'Liked your post', trailing: '15m', emoji: '👨', color: listColors[1] },
          { title: 'Emma Wilson', subtitle: 'Started following you', trailing: '1h', emoji: '👧', color: listColors[2] },
          { title: 'Tech News', subtitle: 'Trending: AI breakthrough', trailing: '2h', emoji: '📰', color: listColors[3] },
          { title: 'Dev Community', subtitle: 'New discussion: Flutter 4', trailing: '4h', emoji: '💻', color: listColors[4] },
          { title: 'Photo Group', subtitle: 'Weekly challenge results', trailing: '6h', emoji: '📷', color: listColors[5] },
        ],
        stats: [
          { label: 'Followers', value: '2.4K', trend: '+124', trendUp: true },
          { label: 'Posts', value: '186', trend: '+12', trendUp: true },
          { label: 'Likes', value: '8.9K', trend: '+340', trendUp: true },
          { label: 'Engagement', value: '6.2%', trend: '+0.8%', trendUp: true },
        ],
        gridItems: [
          { title: 'Photos', price: '42', emoji: '📷' },
          { title: 'Videos', price: '8', emoji: '🎥' },
          { title: 'Stories', price: '15', emoji: '✨' },
          { title: 'Reels', price: '6', emoji: '🎬' },
        ],
        chartBars: [40, 60, 55, 75, 50, 85, 70],
      };
    case 'dashboard':
      return {
        listItems: [
          { title: 'New user signups', subtitle: '45 users today', trailing: '+18%', emoji: '👤', color: listColors[0] },
          { title: 'Revenue today', subtitle: '$2,430 in sales', trailing: '+12%', emoji: '💰', color: listColors[1] },
          { title: 'Active sessions', subtitle: '1,247 online now', trailing: '+5%', emoji: '🔄', color: listColors[2] },
          { title: 'Error rate', subtitle: '0.2% — healthy', trailing: '-0.1%', emoji: '✅', color: listColors[3] },
          { title: 'API latency', subtitle: '142ms avg', trailing: '-8ms', emoji: '⚡', color: listColors[4] },
          { title: 'Storage used', subtitle: '42.3 GB / 100 GB', trailing: '42%', emoji: '💾', color: listColors[5] },
        ],
        stats: [
          { label: 'Revenue', value: '$42.3K', trend: '+18%', trendUp: true },
          { label: 'Users', value: '12,408', trend: '+8%', trendUp: true },
          { label: 'Conversion', value: '4.2%', trend: '+0.5%', trendUp: true },
          { label: 'Churn', value: '1.8%', trend: '-0.3%', trendUp: true },
        ],
        gridItems: [
          { title: 'Today', price: '1.2K', emoji: '📅' },
          { title: 'Week', price: '8.4K', emoji: '📊' },
          { title: 'Month', price: '34K', emoji: '📈' },
          { title: 'Year', price: '412K', emoji: '🏆' },
        ],
        chartBars: [50, 70, 55, 85, 65, 95, 75],
      };
    default:
      return {
        listItems: [
          { title: 'Welcome to your app', subtitle: 'Get started here', trailing: 'New', emoji: '👋', color: listColors[0] },
          { title: 'Settings', subtitle: 'Customize your experience', trailing: '→', emoji: '⚙️', color: listColors[1] },
          { title: 'Profile', subtitle: 'View your account', trailing: '→', emoji: '👤', color: listColors[2] },
          { title: 'Notifications', subtitle: 'Stay updated', trailing: '3', emoji: '🔔', color: listColors[3] },
          { title: 'Help & Support', subtitle: 'Get assistance', trailing: '→', emoji: '❓', color: listColors[4] },
          { title: 'About', subtitle: 'App information', trailing: 'v1.0', emoji: 'ℹ️', color: listColors[5] },
        ],
        stats: [
          { label: 'Total Items', value: '1,248', trend: '+12%', trendUp: true },
          { label: 'Active', value: '842', trend: '+5%', trendUp: true },
          { label: 'Pending', value: '24', trend: '-3', trendUp: false },
          { label: 'Completed', value: '382', trend: '+18', trendUp: true },
        ],
        gridItems: [
          { title: 'Category A', price: '42', emoji: '📦' },
          { title: 'Category B', price: '18', emoji: '📋' },
          { title: 'Category C', price: '7', emoji: '🎯' },
          { title: 'Category D', price: '23', emoji: '💎' },
        ],
        chartBars: [40, 55, 45, 70, 50, 80, 60],
      };
  }
}

function renderScreenHTML(
  screen: ParsedScreen,
  index: number,
  app: ParsedApp,
  appType: string,
  mockData: ReturnType<typeof generateMockData>,
  colors: { bg: string; cardBg: string; textColor: string; muted: string; border: string; pc: string; sc: string },
): string {
  const { cardBg, textColor, muted, border, pc, sc } = colors;
  let html = '';

  // App bar
  if (screen.hasAppBar) {
    html += `<div class="app-bar">`;
    if (index > 0) {
      html += `<div class="action-btn" onclick="switchScreen(0)">←</div>`;
    }
    html += `<h1>${screen.title}</h1>`;
    html += `<div class="actions">`;
    for (const action of screen.appBarActions) {
      const iconMap: Record<string, string> = { search: '🔍', settings: '⚙️', notifications: '🔔', person: '👤', add: '＋', edit: '✏️', delete: '🗑️', share: '↗', more_vert: '⋮', favorite: '♥', close: '✕', menu: '☰' };
      html += `<div class="action-btn">${iconMap[action] || '⋮'}</div>`;
    }
    if (screen.appBarActions.length === 0) {
      html += `<div class="action-btn">⋮</div>`;
    }
    html += `</div></div>`;
  }

  html += `<div class="content scroll-content">`;

  // Render based on appType for the first screen (home/dashboard)
  if (index === 0) {
    // Hero banner for home screen
    if (appType === 'ecommerce' || appType === 'food') {
      html += `<div class="hero-banner"><h2>${appType === 'food' ? 'Free Delivery' : 'Special Offer'}</h2><p>${appType === 'food' ? 'Order from your favorite restaurants' : 'Up to 50% off this week'}</p><div class="deco"></div></div>`;
      html += `<div class="search-bar"><span class="icon">🔍</span><input placeholder="Search..." readonly></div>`;
    } else if (appType === 'finance' || appType === 'dashboard') {
      // Stats grid for dashboard/finance
      html += `<div class="stat-grid">`;
      for (const stat of mockData.stats.slice(0, 4)) {
        html += `<div class="stat-card"><div class="stat-label">${stat.label}</div><div class="stat-value">${stat.value}</div><div class="stat-trend ${stat.trendUp ? 'up' : 'down'}">${stat.trendUp ? '↑' : '↓'} ${stat.trend}</div></div>`;
      }
      html += `</div>`;
      // Chart
      html += `<div class="chart-container"><div class="card-title">Weekly Activity</div><div class="chart-bars">`;
      for (const h of mockData.chartBars) {
        html += `<div class="chart-bar" style="height:${h}%"></div>`;
      }
      html += `</div></div>`;
    } else if (appType === 'chat') {
      // Chat preview
      html += `<div class="chat-container" style="flex:1;display:flex;flex-direction:column;gap:8px">`;
      html += `<div class="chat-msg ai"><div class="avatar">AI</div><div class="chat-bubble">Hello! How can I help you today?</div></div>`;
      html += `<div class="chat-msg user"><div class="chat-bubble">What can this app do?</div></div>`;
      html += `<div class="chat-msg ai"><div class="avatar">AI</div><div class="chat-bubble">This is a preview of your AI chat app. The real app will connect to your AI backend for streaming responses.</div></div>`;
      html += `</div>`;
      html += `<div class="chat-input"><input placeholder="Type a message..." onkeydown="if(event.key==='Enter')sendChat(this.nextElementSibling)"><button onclick="sendChat(this)">➤</button></div>`;
    } else if (appType === 'social') {
      html += `<div class="hero-banner"><h2>${app.appName}</h2><p>Welcome back! Here's what's happening</p><div class="deco"></div></div>`;
    } else if (appType === 'task') {
      html += `<div class="stat-grid">`;
      for (const stat of mockData.stats.slice(0, 4)) {
        html += `<div class="stat-card"><div class="stat-label">${stat.label}</div><div class="stat-value">${stat.value}</div><div class="stat-trend ${stat.trendUp ? 'up' : 'down'}">${stat.trendUp ? '↑' : '↓'} ${stat.trend}</div></div>`;
      }
      html += `</div>`;
    } else {
      html += `<div class="hero-banner"><h2>Welcome to ${app.appName}</h2><p>Your app is ready to explore</p><div class="deco"></div></div>`;
    }
  }

  // Render widgets from Dart analysis
  let listRendered = false;
  let gridRendered = false;
  let statRendered = index === 0 && (appType === 'finance' || appType === 'dashboard' || appType === 'task');

  for (const widget of screen.widgets) {
    switch (widget.type) {
      case 'text':
        if (widget.subtitle === 'small') {
          html += `<p class="text-sm">${widget.text}</p>`;
        } else {
          html += `<p class="text-md">${widget.text}</p>`;
        }
        break;
      case 'input':
        html += `<div class="input-field"><span class="icon">✏️</span><input placeholder="${widget.text}" readonly></div>`;
        break;
      case 'button':
        html += `<button class="btn" onclick="this.style.opacity=0.7;setTimeout(()=>this.style.opacity=1,200)">${widget.text}</button>`;
        break;
      case 'list':
        if (!listRendered) {
          listRendered = true;
          html += `<div class="section-header"><h2>Items</h2><span class="link">See all</span></div>`;
          for (const item of mockData.listItems.slice(0, widget.itemCount || 6)) {
            html += `<div class="list-item"><div class="thumb" style="background:${item.color}20">${item.emoji}</div><div class="info"><div class="title">${item.title}</div><div class="subtitle">${item.subtitle}</div></div><div class="trailing">${item.trailing}</div></div>`;
          }
        }
        break;
      case 'grid':
        if (!gridRendered) {
          gridRendered = true;
          html += `<div class="section-header"><h2>Featured</h2><span class="link">See all</span></div>`;
          html += `<div class="grid-view">`;
          for (const item of mockData.gridItems) {
            html += `<div class="grid-item"><div class="img">${item.emoji}</div><div class="body"><div class="title">${item.title}</div><div class="price">${item.price}</div></div></div>`;
          }
          html += `</div>`;
        }
        break;
      case 'card':
        html += `<div class="card"><div class="card-title">Card Title</div><div class="card-subtitle">Card description goes here</div><div style="height:32px;border-radius:8px;background:${pc}15;margin-top:8px"></div></div>`;
        break;
      case 'image':
        html += `<div style="border-radius:14px;overflow:hidden;height:140px;background:linear-gradient(135deg,${pc}30,${sc}30);display:flex;align-items:center;justify-content:center;font-size:36px">🖼️</div>`;
        break;
      case 'chart':
        html += `<div class="chart-container"><div class="card-title">Analytics</div><div class="chart-bars">`;
        for (const h of mockData.chartBars) {
          html += `<div class="chart-bar" style="height:${h}%"></div>`;
        }
        html += `</div></div>`;
        break;
      case 'stat':
        if (!statRendered) {
          statRendered = true;
          html += `<div class="stat-grid">`;
          for (const stat of mockData.stats.slice(0, 4)) {
            html += `<div class="stat-card"><div class="stat-label">${stat.label}</div><div class="stat-value">${stat.value}</div><div class="stat-trend ${stat.trendUp ? 'up' : 'down'}">${stat.trendUp ? '↑' : '↓'} ${stat.trend}</div></div>`;
          }
          html += `</div>`;
        }
        break;
      case 'chip':
        html += `<div style="display:flex;gap:6px;flex-wrap:wrap"><span class="chip chip-primary">${widget.text}</span><span class="chip chip-neutral">All</span><span class="chip chip-success">Active</span></div>`;
        break;
      case 'toggle':
        html += `<div class="toggle-row"><span style="font-size:12px;font-weight:600">${widget.text}</span><div class="toggle on" onclick="toggleSwitch(this)"><div class="knob"></div></div></div>`;
        break;
      case 'slider':
        html += `<div class="slider-row"><span style="font-size:12px;font-weight:600">Adjust value</span><div class="slider-track"><div class="slider-fill"></div><div class="slider-thumb"></div></div></div>`;
        break;
      case 'tabbar':
        if (widget.children && widget.children.length > 0) {
          html += `<div class="tab-bar">`;
          widget.children.forEach((child, i) => {
            html += `<div class="tab-item ${i === 0 ? 'active' : ''}" onclick="this.parentElement.querySelectorAll('.tab-item').forEach(t=>t.classList.remove('active'));this.classList.add('active')">${child.text}</div>`;
          });
          html += `</div>`;
        }
        break;
      case 'divider':
        html += `<div class="divider"></div>`;
        break;
      case 'avatar':
        html += `<div style="display:flex;align-items:center;gap:10px"><div class="avatar">U</div><div><div style="font-size:12px;font-weight:700">User Name</div><div class="text-xs">user@example.com</div></div></div>`;
        break;
      case 'fab':
        break; // handled separately
      default:
        break;
    }
  }

  // If nothing was rendered, show a placeholder
  if (screen.widgets.length === 0 || (listRendered === false && gridRendered === false && statRendered === false && screen.widgets.every((w) => w.type === 'text'))) {
    // Add default list if no structured content
    if (!listRendered && appType !== 'chat') {
      html += `<div class="section-header"><h2>Recent Activity</h2></div>`;
      for (const item of mockData.listItems.slice(0, 4)) {
        html += `<div class="list-item"><div class="thumb" style="background:${item.color}20">${item.emoji}</div><div class="info"><div class="title">${item.title}</div><div class="subtitle">${item.subtitle}</div></div><div class="trailing">${item.trailing}</div></div>`;
      }
    }
  }

  html += `</div>`;

  // FAB
  if (screen.hasFab) {
    html += `<div class="fab" onclick="this.style.transform='scale(0.9)';setTimeout(()=>this.style.transform='',150)">+</div>`;
  }

  return html;
}

// ── Store ──────────────────────────────────────────────────────────────

export const usePreviewStore = create<PreviewState>((set, get) => ({
  sessions: {},
  currentSessionId: null,
  isLoading: false,
  error: null,

  getSession: (projectId) => get().sessions[projectId] || null,
  getStatus: (projectId) => get().sessions[projectId]?.status || 'idle',

  build: async (projectId, files, opts) => {
    set({ isLoading: true, error: null });
    try {
      const realFiles = files.filter((f) => f.content && !f.path.endsWith('/'));
      if (realFiles.length === 0) {
        throw new Error('No files to preview. Generate your app first.');
      }

      const sessionId = `preview-${projectId}-${Date.now()}`;

      const session: PreviewSession = {
        sessionId,
        projectId,
        status: 'building',
        html: null,
        logs: ['Analyzing project files...'],
        createdAt: Date.now(),
      };
      set((s) => ({ sessions: { ...s.sessions, [projectId]: session }, currentSessionId: sessionId, isLoading: false }));

      // Build the HTML preview
      await new Promise((resolve) => setTimeout(resolve, 300));
      const html = generatePreviewHTML(realFiles, opts);

      set((s) => ({
        sessions: {
          ...s.sessions,
          [projectId]: {
            ...s.sessions[projectId],
            status: 'running',
            html,
            logs: [...(s.sessions[projectId]?.logs || []), 'Preview compiled successfully', 'Rendering app UI...'],
          },
        },
      }));

      return sessionId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ error: msg, isLoading: false });
      throw e;
    }
  },

  stop: async (sessionId) => {
    const state = get();
    for (const [pid, sess] of Object.entries(state.sessions)) {
      if (sess.sessionId === sessionId) {
        set((s) => ({
          sessions: {
            ...s.sessions,
            [pid]: { ...s.sessions[pid], status: 'stopped', html: null },
          },
        }));
        break;
      }
    }
  },

  refresh: (projectId) => {
    set((s) => {
      const sess = s.sessions[projectId];
      if (!sess) return s;
      return {
        sessions: {
          ...s.sessions,
          [projectId]: { ...sess, html: sess.html ? `${sess.html}<!--refresh:${Date.now()}-->` : null },
        },
      };
    });
  },

  clearError: () => set({ error: null }),
}));
