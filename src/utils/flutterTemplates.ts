import type { FileChange, ThemeConfig } from '@/types';

export const DEFAULT_THEME: ThemeConfig = {
  colors: {
    primary: '#3B82F6',
    secondary: '#8B5CF6',
    background: '#FFFFFF',
    surface: '#F9FAFB',
    error: '#EF4444',
    success: '#10B981',
    warning: '#F59E0B',
    text: '#111827',
  },
  typography: {
    display: '32',
    heading: '24',
    subtitle: '18',
    body: '16',
    caption: '14',
  },
  spacing: {
    xs: '4',
    sm: '8',
    md: '16',
    lg: '24',
    xl: '32',
  },
  radius: '12',
  elevation: '4',
  mode: 'light',
};

export function generateMainDart(appName: string): string {
  const pascalName = toPascalCase(appName);
  return `import 'package:flutter/material.dart';
import 'app.dart';

void main() {
  runApp(${pascalName}App());
}
`;
}

export function generateAppDart(appName: string, theme: ThemeConfig): string {
  const pascalName = toPascalCase(appName);
  const isDark = theme.mode === 'dark';
  return `import 'package:flutter/material.dart';
import 'core/theme/app_theme.dart';
import 'core/router/app_router.dart';

class ${pascalName}App extends StatelessWidget {
  const ${pascalName}App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: '${appName}',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.lightTheme,
      darkTheme: AppTheme.darkTheme,
      themeMode: ThemeMode.${isDark ? 'dark' : 'light'},
      routerConfig: AppRouter.router,
    );
  }
}
`;
}

export function generateThemeFile(theme: ThemeConfig): string {
  return `import 'package:flutter/material.dart';

class AppTheme {
  static const Color primary = Color(0xFF${theme.colors.primary.replace('#', '')});
  static const Color secondary = Color(0xFF${theme.colors.secondary.replace('#', '')});
  static const Color background = Color(0xFF${theme.colors.background.replace('#', '')});
  static const Color surface = Color(0xFF${theme.colors.surface.replace('#', '')});
  static const Color error = Color(0xFF${theme.colors.error.replace('#', '')});
  static const Color success = Color(0xFF${theme.colors.success.replace('#', '')});
  static const Color warning = Color(0xFF${theme.colors.warning.replace('#', '')});
  static const Color text = Color(0xFF${theme.colors.text.replace('#', '')});

  static ThemeData get lightTheme => ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(
      seedColor: primary,
      brightness: Brightness.light,
    ),
    scaffoldBackgroundColor: background,
    cardColor: surface,
    appBarTheme: AppBarTheme(
      backgroundColor: background,
      foregroundColor: text,
      elevation: 0,
      centerTitle: false,
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: primary,
        foregroundColor: Colors.white,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(${theme.radius}),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: surface,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(${theme.radius}),
        borderSide: BorderSide.none,
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
    ),
    cardTheme: CardTheme(
      elevation: ${theme.elevation},
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(${theme.radius}),
      ),
      color: surface,
    ),
  );

  static ThemeData get darkTheme => ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.fromSeed(
      seedColor: primary,
      brightness: Brightness.dark,
    ),
    scaffoldBackgroundColor: const Color(0xFF111827),
    cardColor: const Color(0xFF1F2937),
    appBarTheme: const AppBarTheme(
      backgroundColor: Color(0xFF111827),
      foregroundColor: Colors.white,
      elevation: 0,
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: primary,
        foregroundColor: Colors.white,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(${theme.radius}),
        ),
      ),
    ),
  );
}
`;
}

export function generateRouter(screens: string[]): string {
  const routes = screens.map((s) => {
    const pascal = toPascalCase(s);
    const snake = toSnakeCase(s);
    return `  static final routes = [
    GoRoute(
      path: '/${snake}',
      name: '${snake}',
      builder: (context, state) => const ${pascal}Screen(),
    ),`;
  }).join('\n');

  return `import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
${screens.map((s) => `import '../screens/${toSnakeCase(s)}/${toSnakeCase(s)}_screen.dart';`).join('\n')}

class AppRouter {
${routes}
  ];

  static GoRouter get router => GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(
        path: '/',
        builder: (context, state) => const Scaffold(
          body: Center(child: Text('Home')),
        ),
      ),
      ...routes,
    ],
  );
}
`;
}

export function generateScreen(name: string, theme: ThemeConfig): string {
  const pascal = toPascalCase(name);
  const snake = toSnakeCase(name);
  return `import 'package:flutter/material.dart';
import '../../core/theme/app_theme.dart';

class ${pascal}Screen extends StatelessWidget {
  const ${pascal}Screen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('${pascal}'),
      ),
      body: Center(
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.widgets,
                  size: 48,
                  color: AppTheme.primary,
                ),
                const SizedBox(height: 16),
                Text(
                  '${pascal} Screen',
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const SizedBox(height: 8),
                Text(
                  'This screen was generated by FlutterForge',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
`;
}

export function generatePubspec(name: string, dependencies: string[] = []): string {
  const snake = toSnakeCase(name);
  const deps = dependencies.map((d) => `  ${d}`).join('\n');
  return `name: ${snake}
description: A Flutter application generated by FlutterForge
publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  go_router: ^14.0.0
${deps}

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^4.0.0

flutter:
  uses-material-design: true
  assets:
    - assets/images/
    - assets/icons/
`;
}

export function generateAnalysisOptions(): string {
  return `include: package:flutter_lints/flutter.yaml

linter:
  rules:
    prefer_const_constructors: true
    prefer_const_literals_to_create_immutables: true
    avoid_print: true
    prefer_single_quotes: true
`;
}

export function generateReadme(name: string): string {
  return `# ${name}

A Flutter application generated by FlutterForge.

## Getting Started

\`\`\`bash
flutter pub get
flutter run
\`\`\`

## Build

\`\`\`bash
flutter build web
\`\`\`

## Generated by FlutterForge

This project was created using [FlutterForge](https://flutterforge.app) - AI-powered Flutter app generation.
`;
}

export function generateFlutterProjectFiles(
  appName: string,
  template: string,
  screens: string[] = ['home'],
  dependencies: string[] = [],
  theme: ThemeConfig = DEFAULT_THEME
): FileChange[] {
  const changes: FileChange[] = [];

  changes.push({
    path: 'lib/main.dart',
    action: 'created',
    content: generateMainDart(appName),
  });
  changes.push({
    path: 'lib/app.dart',
    action: 'created',
    content: generateAppDart(appName, theme),
  });
  changes.push({
    path: 'lib/core/theme/app_theme.dart',
    action: 'created',
    content: generateThemeFile(theme),
  });
  changes.push({
    path: 'lib/core/router/app_router.dart',
    action: 'created',
    content: generateRouter(screens),
  });

  for (const screen of screens) {
    changes.push({
      path: `lib/screens/${toSnakeCase(screen)}/${toSnakeCase(screen)}_screen.dart`,
      action: 'created',
      content: generateScreen(screen, theme),
    });
  }

  changes.push({
    path: 'pubspec.yaml',
    action: 'created',
    content: generatePubspec(appName, dependencies),
  });
  changes.push({
    path: 'analysis_options.yaml',
    action: 'created',
    content: generateAnalysisOptions(),
  });
  changes.push({
    path: 'README.md',
    action: 'created',
    content: generateReadme(appName),
  });

  changes.push({
    path: 'preview/index.html',
    action: 'created',
    content: generatePreviewHtml(appName, theme, screens),
  });

  return changes;
}

function generatePreviewHtml(appName: string, theme: ThemeConfig, screens: string[]): string {
  const primary = theme.colors.primary;
  const secondary = theme.colors.secondary;
  const isDark = theme.mode === 'dark';
  const bg = isDark ? '#1a1a2e' : theme.colors.background;
  const cardBg = isDark ? '#2d2d44' : theme.colors.surface;
  const textColor = isDark ? '#f1f1f1' : theme.colors.text;
  const muted = isDark ? '#9ca3af' : '#6b7280';
  const border = isDark ? '#374151' : '#e5e7eb';
  const screenNames = screens.length > 0 ? screens : ['home'];
  const navItems = screenNames.map((s, i) =>
    `<button class="nav-btn ${i === 0 ? 'active' : ''}" data-screen="${i}"><span class="nav-dot"></span><span class="nav-label">${s.charAt(0).toUpperCase() + s.slice(1)}</span></button>`
  ).join('');
  const screenSections = screenNames.map((s, i) => {
    const name = s.charAt(0).toUpperCase() + s.slice(1);
    return `<div class="screen ${i === 0 ? 'active' : ''}" data-screen="${i}">
      <div class="screen-content">
        <div class="text-widget">${name} Screen</div>
        <div class="card-widget"><div class="card-line" style="width:75%"></div><div class="card-line" style="width:50%"></div><div class="card-accent"></div></div>
        <div class="list-item"><div class="thumb"></div><div class="lines"><div class="line med"></div><div class="line short"></div></div><div class="badge"></div></div>
        <div class="list-item"><div class="thumb"></div><div class="lines"><div class="line med"></div><div class="line short"></div></div><div class="badge"></div></div>
        <button class="btn-widget">Get Started</button>
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${appName} Preview</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
:root{--bg:${bg};--card:${cardBg};--text:${textColor};--muted:${muted};--border:${border};--primary:${primary};--secondary:${secondary}}
body{background:var(--bg);color:var(--text);min-height:100vh}
.status-bar{display:flex;justify-content:space-between;padding:4px 16px 2px;font-size:10px;font-weight:700;color:var(--text)}
.app-bar{background:var(--primary);color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 2px 8px rgba(0,0,0,.15)}
.app-bar h1{font-size:14px;font-weight:800}
.app-bar .avatar{width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}
.screen{display:none}.screen.active{display:block}
.screen-content{padding:12px;display:flex;flex-direction:column;gap:12px;min-height:calc(100vh - 120px)}
.text-widget{font-size:12px;font-weight:600;color:var(--text);padding:4px}
.card-widget{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:8px}
.card-widget .card-line{height:12px;border-radius:4px;background:var(--border)}
.card-widget .card-accent{height:32px;border-radius:8px;background:var(--primary)15;margin-top:4px}
.list-item{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px;display:flex;align-items:center;gap:12px}
.list-item .thumb{width:40px;height:40px;border-radius:8px;background:var(--primary)20;flex-shrink:0}
.list-item .lines{flex:1;display:flex;flex-direction:column;gap:6px}
.list-item .line{height:10px;border-radius:4px;background:var(--border)}
.list-item .line.short{width:50%}
.list-item .line.med{width:70%}
.list-item .badge{height:10px;border-radius:4px;background:var(--border);width:48px}
.btn-widget{width:100%;padding:10px;border-radius:12px;background:var(--primary);color:#fff;border:none;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px ${primary}40}
.btn-widget:hover{filter:brightness(1.1)}
.bottom-nav{position:fixed;bottom:0;left:0;right:0;display:flex;background:var(--card);border-top:1px solid var(--border);padding:8px 0 12px}
.nav-btn{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;background:none;border:none;cursor:pointer}
.nav-dot{width:16px;height:16px;border-radius:6px;background:transparent;transition:all .2s}
.nav-btn.active .nav-dot{background:var(--primary)}
.nav-btn:not(.active) .nav-dot{background:var(--muted);opacity:.3}
.nav-label{font-size:9px;color:var(--muted);font-weight:500}
.nav-btn.active .nav-label{color:var(--primary);font-weight:700}
</style>
</head>
<body>
<div class="status-bar"><span>9:41</span><span>● ● ●</span></div>
<div class="app-bar"><h1>${appName}</h1><div class="avatar">${appName.charAt(0)}</div></div>
${screenSections}
<nav class="bottom-nav">${navItems}</nav>
<script>
document.querySelectorAll('.nav-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const idx=btn.dataset.screen;
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    document.querySelector('.screen[data-screen="'+idx+'"]').classList.add('active');
    document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
  });
});
</script>
</body>
</html>`;
}

function toPascalCase(str: string): string {
  return str
    .split(/[_\s-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, ' $1')
    .trim()
    .split(/[\s_-]+/)
    .map((w) => w.toLowerCase())
    .join('_');
}

export { toPascalCase, toSnakeCase };
