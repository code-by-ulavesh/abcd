import { useState, useEffect, useMemo, useRef } from 'react';
import {
  ArrowLeft,
  Search,
  Bell,
  MoreVertical,
  Settings,
  User,
  Plus,
  Home,
  ShoppingCart,
  BarChart3,
  MessageCircle,
  LayoutGrid,
  FileCode2,
  Play,
} from 'lucide-react';
import type { ProjectFile } from '@/types';
import { usePreviewStore } from '@/stores/preview.store';

interface PreviewCanvasProps {
  files: ProjectFile[];
  projectName?: string;
  activeScreen?: string;
  onScreenChange?: (screen: string) => void;
  inspectMode?: boolean;
  onRun?: () => void;
}

interface ParsedScreen {
  name: string;
  title: string;
  hasAppBar: boolean;
  hasFab: boolean;
  appBarActions: string[];
  widgets: ParsedWidget[];
}

interface ParsedWidget {
  type: string;
  text?: string;
  itemCount?: number;
  children?: ParsedWidget[];
}

interface ParsedApp {
  appName: string;
  primaryColor: string;
  secondaryColor: string;
  isDark: boolean;
  screens: ParsedScreen[];
  appType: string;
}

function extractColor(code: string, key: string): string | null {
  const m = code.match(new RegExp(`${key}:\\s*Color\\(0x(?:FF)?([0-9A-Fa-f]{6,8})\\)`));
  if (m) {
    const hex = m[1].length === 8 ? m[1].slice(2) : m[1];
    return `#${hex}`;
  }
  return null;
}

function inferAppType(code: string): string {
  const lower = code.toLowerCase();
  if (/shop|cart|product|order|checkout|ecommerce|store/.test(lower)) return 'ecommerce';
  if (/chat|message|conversation|stream.*response/.test(lower)) return 'chat';
  if (/finance|wallet|transaction|budget|expense|balance/.test(lower)) return 'finance';
  if (/food|restaurant|delivery|menu/.test(lower)) return 'food';
  if (/task|todo|kanban|board/.test(lower)) return 'task';
  if (/dashboard|analytics|chart|stat|metric|report/.test(lower)) return 'dashboard';
  if (/social|feed|post|like|comment|follow/.test(lower)) return 'social';
  return 'generic';
}

function extractWidgets(code: string): ParsedWidget[] {
  const widgets: ParsedWidget[] = [];

  const appBarTitle = code.match(/AppBar[\s\S]*?title:\s*Text\(\s*['"]([^'"]+)['"]/);
  if (appBarTitle) widgets.push({ type: 'text', text: appBarTitle[1] });

  const textMatches = [...code.matchAll(/Text\(\s*['"]([^'"]{2,})['"]/g)];
  const seen = new Set<string>();
  for (const m of textMatches) {
    if (!seen.has(m[1]) && m[1].length > 2) {
      seen.add(m[1]);
      widgets.push({ type: 'text', text: m[1] });
    }
  }

  if (/TextField|TextFormField/i.test(code)) {
    const hintMatch = code.match(/hintText:\s*['"]([^'"]+)['"]/);
    widgets.push({ type: 'input', text: hintMatch?.[1] || 'Enter text...' });
  }

  if (/ElevatedButton|FilledButton|RaisedButton/i.test(code)) {
    const labelMatch = code.match(/(?:ElevatedButton|FilledButton)[\s\S]*?child:\s*Text\(\s*['"]([^'"]+)['"]/);
    widgets.push({ type: 'button', text: labelMatch?.[1] || 'Submit' });
  }

  if (/ListView|GridView/i.test(code)) {
    const countMatch = code.match(/itemCount:\s*(\d+)/);
    const isGrid = /GridView/.test(code);
    widgets.push({ type: isGrid ? 'grid' : 'list', itemCount: parseInt(countMatch?.[1] || '6') });
  }

  if (/Card\(/.test(code)) widgets.push({ type: 'card' });
  if (/NetworkImage|Image\.network/i.test(code)) widgets.push({ type: 'image' });
  if (/LineChart|BarChart|PieChart|fl_chart/i.test(code)) widgets.push({ type: 'chart' });
  if (/Switch\(/.test(code)) widgets.push({ type: 'toggle' });
  if (/Chip\(/.test(code)) widgets.push({ type: 'chip' });
  if (/TabBar\(/.test(code)) {
    const tabMatches = [...code.matchAll(/Tab\(\s*(?:text:\s*['"]([^'"]+)['"]|child:\s*Text\(\s*['"]([^'"]+)['"]\))/g)];
    widgets.push({ type: 'tabbar', children: tabMatches.map((m) => ({ type: 'text', text: m[1] || m[2] || '' })) });
  }
  if (/Divider\(/.test(code)) widgets.push({ type: 'divider' });

  return widgets.length > 0 ? widgets : [{ type: 'text', text: 'Welcome' }];
}

function parseDartProject(files: ProjectFile[]): ParsedApp {
  const dartFiles = files.filter((f) => !f.is_directory && f.path.endsWith('.dart') && f.content);
  const combined = dartFiles.map((f) => f.content || '').join('\n');

  const appName = combined.match(/title:\s*['"]([^'"]+)['"]/)?.[1] || 'Flutter App';
  const primaryColor = extractColor(combined, 'primaryColor') || extractColor(combined, 'seedColor') || '#3B82F6';
  const secondaryColor = extractColor(combined, 'secondaryColor') || '#10B981';
  const isDark = /brightness:\s*Brightness\.dark|ThemeData\.dark/i.test(combined);
  const appType = inferAppType(combined);

  const screenFiles = dartFiles.filter(
    (f) => f.path.includes('/screens/') || f.path.includes('/pages/') || f.path.includes('/views/') || f.path === 'lib/main.dart'
  );

  const screens: ParsedScreen[] = [];
  for (const file of screenFiles) {
    const content = file.content || '';
    const rawName = file.path.split('/').pop()?.replace('_screen.dart', '').replace('_page.dart', '').replace('_view.dart', '').replace('.dart', '') || 'Screen';
    const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
    const title = content.match(/AppBar[\s\S]*?title:\s*Text\(\s*['"]([^'"]+)['"]/)?.[1] || name;
    const hasAppBar = /AppBar\(/.test(content);
    const hasFab = /FloatingActionButton\(/.test(content);
    const actionMatches = [...content.matchAll(/IconButton\([\s\S]*?icon:\s*Icon\(\s*Icons\.(\w+)\)/g)];
    const appBarActions = actionMatches.map((m) => m[1]).slice(0, 3);
    screens.push({ name, title, hasAppBar, hasFab, appBarActions, widgets: extractWidgets(content) });
  }

  if (screens.length === 0) {
    screens.push({ name: 'Home', title: appName, hasAppBar: true, hasFab: false, appBarActions: [], widgets: extractWidgets(combined) });
  }

  return { appName, primaryColor, secondaryColor, isDark, screens, appType };
}

const NAV_ICONS: Record<string, typeof Home> = {
  home: Home, dash: LayoutGrid, search: Search, cart: ShoppingCart, shop: ShoppingCart,
  order: ShoppingCart, profile: User, account: User, setting: Settings, chart: BarChart3,
  analytics: BarChart3, chat: MessageCircle, message: MessageCircle,
};

function getNavIcon(name: string): typeof Home {
  const lower = name.toLowerCase();
  for (const [key, icon] of Object.entries(NAV_ICONS)) {
    if (lower.includes(key)) return icon;
  }
  return FileCode2;
}

const MOCK_LIST = [
  { title: 'First Item', subtitle: 'Description text', trailing: '$99', emoji: '📦', color: '#3B82F6' },
  { title: 'Second Item', subtitle: 'More details here', trailing: '$45', emoji: '🎯', color: '#10B981' },
  { title: 'Third Item', subtitle: 'Additional info', trailing: '$78', emoji: '💎', color: '#F59E0B' },
  { title: 'Fourth Item', subtitle: 'Short description', trailing: '$120', emoji: '⭐', color: '#EF4444' },
  { title: 'Fifth Item', subtitle: 'Last item', trailing: '$32', emoji: '🔥', color: '#8B5CF6' },
  { title: 'Sixth Item', subtitle: 'Final entry', trailing: '$56', emoji: '✨', color: '#EC4899' },
];

const MOCK_STATS = [
  { label: 'Total', value: '1,248', trend: '+12%', up: true },
  { label: 'Active', value: '842', trend: '+5%', up: true },
  { label: 'Revenue', value: '$12.4K', trend: '+18%', up: true },
  { label: 'Growth', value: '6.2%', trend: '+0.8%', up: true },
];

const CHART_BARS = [50, 70, 45, 85, 60, 90, 65];

export function PreviewCanvas({
  files,
  projectName = 'Flutter App',
  activeScreen,
  onScreenChange,
  inspectMode = false,
  onRun,
}: PreviewCanvasProps) {
  const [activeTab, setActiveTab] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const preview = usePreviewStore();
  const projectId = 'preview-canvas';
  const session = preview.getSession(projectId);

  const parsed = useMemo(() => parseDartProject(files), [files]);
  const tabs = parsed.screens.map((s) => s.name);
  const currentScreen = parsed.screens[activeTab] || parsed.screens[0];

  useEffect(() => {
    if (activeScreen) {
      const idx = tabs.findIndex((t) => t.toLowerCase() === activeScreen.toLowerCase());
      if (idx >= 0) setActiveTab(idx);
    }
  }, [activeScreen, tabs.length]);

  // Auto-build iframe preview if we have files but no running session
  useEffect(() => {
    const realFiles = files.filter((f) => !f.is_directory && f.content).map((f) => ({ path: f.path, content: f.content }));
    if (realFiles.length > 0 && !session) {
      void preview.build(projectId, realFiles);
    }
  }, [files.length]);

  const hasHtml = session?.status === 'running' && !!session.html;

  const bg = parsed.isDark ? '#0f1117' : '#f8fafc';
  const cardBg = parsed.isDark ? '#1e1e2e' : '#ffffff';
  const textColor = parsed.isDark ? '#f1f5f9' : '#0f172a';
  const muted = parsed.isDark ? '#94a3b8' : '#64748b';
  const border = parsed.isDark ? '#334155' : '#e2e8f0';
  const pc = parsed.primaryColor;

  // If we have an HTML preview, render it in an iframe
  if (hasHtml && session?.html) {
    return (
      <div className="relative w-full h-full">
        <iframe
          ref={iframeRef}
          srcDoc={session.html}
          title="App Preview"
          className="w-full h-full border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
        {onRun && (
          <button
            onClick={onRun}
            className="absolute top-2 right-2 z-30 flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-black/60 backdrop-blur-md hover:bg-black/80 text-[10px] font-bold text-emerald-400 border border-white/10 transition-all shadow-sm"
          >
            <Play size={10} />
            <span>Live Build</span>
          </button>
        )}
      </div>
    );
  }

  // Building state
  if (session?.status === 'building') {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center" style={{ backgroundColor: bg }}>
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-3" style={{ background: `${pc}20` }}>
          <div className="w-6 h-6 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: pc, borderTopColor: 'transparent' }} />
        </div>
        <p className="text-xs font-semibold" style={{ color: textColor }}>Building preview...</p>
      </div>
    );
  }

  // Fallback: render React-based mockup
  return (
    <div className="w-full h-full flex flex-col overflow-hidden select-none" style={{ backgroundColor: bg, fontFamily: 'Inter, sans-serif' }}>
      {/* Status Bar */}
      <div className="flex items-center justify-between px-5 pt-2 pb-1 shrink-0" style={{ color: textColor }}>
        <span className="text-[10px] font-bold">9:41</span>
        <div className="flex items-center gap-1">
          <div className="w-3 h-2 rounded-sm" style={{ background: textColor, opacity: 0.7 }} />
          <div className="w-2.5 h-2 rounded-sm" style={{ background: textColor, opacity: 0.4 }} />
        </div>
      </div>

      {/* App Bar */}
      {currentScreen?.hasAppBar && (
        <div className="px-4 py-3 shrink-0 flex items-center justify-between text-white" style={{ background: pc, boxShadow: '0 2px 8px rgba(0,0,0,.08)' }}>
          <div className="flex items-center gap-2">
            {activeTab > 0 && (
              <button onClick={() => { setActiveTab(0); onScreenChange?.(tabs[0]); }} className="p-1 -ml-1 rounded hover:bg-white/20">
                <ArrowLeft size={16} />
              </button>
            )}
            <div>
              <h2 className="text-xs font-extrabold tracking-tight">{currentScreen.title}</h2>
              <p className="text-[9px] text-white/80">{projectName}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {currentScreen.appBarActions.slice(0, 2).map((action, i) => {
              const Icon = action.includes('search') ? Search : action.includes('bell') || action.includes('notif') ? Bell : action.includes('setting') ? Settings : action.includes('person') ? User : MoreVertical;
              return <div key={i} className="w-7 h-7 rounded-lg bg-white/15 flex items-center justify-center"><Icon size={13} /></div>;
            })}
            {currentScreen.appBarActions.length === 0 && <div className="w-7 h-7 rounded-lg bg-white/15 flex items-center justify-center"><MoreVertical size={13} /></div>}
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3" style={{ backgroundColor: bg, paddingBottom: 70 }}>
        {inspectMode && (
          <div className="p-2.5 rounded-lg text-[10px] font-mono border" style={{ background: `${pc}10`, borderColor: `${pc}30`, color: pc }}>
            Inspect Mode: Hover elements to see widget info
          </div>
        )}

        {/* Home screen: show stats + chart + list */}
        {activeTab === 0 && (
          <>
            {/* Hero banner */}
            <div className="rounded-2xl p-4 text-white relative overflow-hidden" style={{ background: `linear-gradient(135deg, ${pc}, ${parsed.secondaryColor})` }}>
              <h3 className="text-sm font-extrabold">Welcome to {projectName}</h3>
              <p className="text-[10px] opacity-90 mt-0.5">Your app is ready to explore</p>
              <div className="absolute -right-4 -bottom-4 w-20 h-20 rounded-full bg-white/10" />
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-2.5">
              {MOCK_STATS.map((stat, i) => (
                <div key={i} className="rounded-xl p-3 border" style={{ background: cardBg, borderColor: border }}>
                  <p className="text-[9px] font-medium" style={{ color: muted }}>{stat.label}</p>
                  <p className="text-base font-extrabold mt-0.5" style={{ color: textColor }}>{stat.value}</p>
                  <p className="text-[9px] font-bold mt-0.5" style={{ color: stat.up ? '#10B981' : '#EF4444' }}>
                    {stat.up ? '↑' : '↓'} {stat.trend}
                  </p>
                </div>
              ))}
            </div>

            {/* Chart */}
            <div className="rounded-xl p-3 border" style={{ background: cardBg, borderColor: border }}>
              <p className="text-[11px] font-bold mb-2" style={{ color: textColor }}>Weekly Activity</p>
              <div className="flex items-end gap-1.5 h-16">
                {CHART_BARS.map((h, i) => (
                  <div key={i} className="flex-1 rounded-t" style={{ height: `${h}%`, background: `linear-gradient(to top, ${pc}, ${pc}80)`, minHeight: 4 }} />
                ))}
              </div>
            </div>
          </>
        )}

        {/* Render widgets */}
        {currentScreen?.widgets.map((widget, i) => {
          switch (widget.type) {
            case 'text':
              return <p key={i} className="text-xs font-semibold px-1" style={{ color: textColor }}>{widget.text}</p>;
            case 'input':
              return (
                <div key={i} className="rounded-xl px-3 py-2.5 flex items-center gap-2 border" style={{ background: cardBg, borderColor: border }}>
                  <Search size={13} style={{ color: muted }} />
                  <span className="text-[10px]" style={{ color: muted }}>{widget.text}</span>
                </div>
              );
            case 'button':
              return (
                <button key={i} className="w-full py-2.5 rounded-xl text-white text-[11px] font-bold transition-all hover:brightness-110 active:scale-95" style={{ background: pc, boxShadow: `0 4px 12px ${pc}40` }}>
                  {widget.text}
                </button>
              );
            case 'list':
              return (
                <div key={i} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-extrabold" style={{ color: textColor }}>Recent Items</h3>
                    <span className="text-[9px] font-semibold" style={{ color: pc }}>See all</span>
                  </div>
                  {MOCK_LIST.slice(0, Math.min(widget.itemCount || 4, 5)).map((item, j) => (
                    <div key={j} className="rounded-xl p-3 flex items-center gap-3 border transition-all hover:border-current" style={{ background: cardBg, borderColor: border }}>
                      <div className="w-10 h-10 rounded-lg shrink-0 flex items-center justify-center text-lg" style={{ background: `${item.color}20` }}>{item.emoji}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] font-semibold truncate" style={{ color: textColor }}>{item.title}</p>
                        <p className="text-[9px] truncate mt-0.5" style={{ color: muted }}>{item.subtitle}</p>
                      </div>
                      <span className="text-[10px] font-bold" style={{ color: pc }}>{item.trailing}</span>
                    </div>
                  ))}
                </div>
              );
            case 'grid':
              return (
                <div key={i}>
                  <h3 className="text-xs font-extrabold mb-2" style={{ color: textColor }}>Featured</h3>
                  <div className="grid grid-cols-2 gap-2">
                    {MOCK_LIST.slice(0, 4).map((item, j) => (
                      <div key={j} className="rounded-xl overflow-hidden border transition-all hover:scale-[1.02]" style={{ background: cardBg, borderColor: border }}>
                        <div className="h-16 flex items-center justify-center text-2xl" style={{ background: `linear-gradient(135deg, ${pc}25, ${parsed.secondaryColor}25)` }}>{item.emoji}</div>
                        <div className="p-2">
                          <p className="text-[10px] font-bold truncate" style={{ color: textColor }}>{item.title}</p>
                          <p className="text-[11px] font-extrabold mt-0.5" style={{ color: pc }}>{item.trailing}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            case 'card':
              return (
                <div key={i} className="rounded-xl p-3.5 border space-y-2" style={{ background: cardBg, borderColor: border }}>
                  <div className="h-2.5 rounded w-3/4" style={{ background: border }} />
                  <div className="h-2 rounded w-1/2" style={{ background: border }} />
                  <div className="h-7 rounded-lg" style={{ background: `${pc}15` }} />
                </div>
              );
            case 'image':
              return <div key={i} className="rounded-xl h-28 flex items-center justify-center text-3xl" style={{ background: `linear-gradient(135deg, ${pc}25, ${parsed.secondaryColor}25)` }}>🖼️</div>;
            case 'chart':
              return (
                <div key={i} className="rounded-xl p-3 border" style={{ background: cardBg, borderColor: border }}>
                  <p className="text-[11px] font-bold mb-2" style={{ color: textColor }}>Analytics</p>
                  <div className="flex items-end gap-1.5 h-14">
                    {CHART_BARS.map((h, j) => (
                      <div key={j} className="flex-1 rounded-t" style={{ height: `${h}%`, background: pc, minHeight: 3, opacity: 0.7 + (j / 14) }} />
                    ))}
                  </div>
                </div>
              );
            case 'toggle':
              return (
                <div key={i} className="flex items-center justify-between p-3 rounded-xl border" style={{ background: cardBg, borderColor: border }}>
                  <span className="text-[11px] font-semibold" style={{ color: textColor }}>{widget.text || 'Enable'}</span>
                  <div className="w-9 h-5 rounded-full flex items-center px-0.5" style={{ background: pc }}>
                    <div className="w-4 h-4 rounded-full bg-white ml-auto" />
                  </div>
                </div>
              );
            case 'chip':
              return (
                <div key={i} className="flex gap-1.5 flex-wrap">
                  <span className="px-2.5 py-1 rounded-full text-[9px] font-semibold" style={{ background: `${pc}20`, color: pc }}>{widget.text || 'Filter'}</span>
                  <span className="px-2.5 py-1 rounded-full text-[9px] font-semibold" style={{ background: border, color: muted }}>All</span>
                  <span className="px-2.5 py-1 rounded-full text-[9px] font-semibold" style={{ background: '#10B98120', color: '#10B981' }}>Active</span>
                </div>
              );
            case 'divider':
              return <div key={i} className="h-px" style={{ background: border }} />;
            default:
              return null;
          }
        })}

        {/* FAB */}
        {currentScreen?.hasFab && (
          <div className="fixed bottom-16 right-4 w-11 h-11 rounded-full flex items-center justify-center shadow-lg" style={{ background: pc, boxShadow: `0 6px 16px ${pc}50` }}>
            <Plus size={20} className="text-white" />
          </div>
        )}
      </div>

      {/* Bottom Nav */}
      {tabs.length > 1 && (
        <div className="flex items-center border-t shrink-0 pb-3 pt-2 px-1" style={{ background: cardBg, borderColor: parsed.isDark ? '#334155' : '#f3f4f6' }}>
          {tabs.slice(0, 5).map((tab, i) => {
            const isActive = activeTab === i;
            const Icon = getNavIcon(tab);
            return (
              <button
                key={tab}
                onClick={() => { setActiveTab(i); onScreenChange?.(tab); }}
                className="flex-1 flex flex-col items-center gap-1 transition-all"
              >
                <Icon size={16} style={{ color: isActive ? pc : muted }} strokeWidth={isActive ? 2.5 : 2} />
                <span className="text-[8px] font-medium truncate max-w-full px-0.5" style={{ color: isActive ? pc : muted, fontWeight: isActive ? 700 : 500 }}>
                  {tab}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Run button overlay */}
      {onRun && (
        <button
          onClick={onRun}
          className="absolute top-2 right-2 z-30 flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-black/60 backdrop-blur-md hover:bg-black/80 text-[10px] font-bold text-emerald-400 border border-white/10 transition-all shadow-sm"
        >
          <Play size={10} />
          <span>Live Build</span>
        </button>
      )}
    </div>
  );
}
