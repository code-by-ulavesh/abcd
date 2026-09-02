import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey, X-OpenRouter-Key, X-OpenRouter-Model",
};

const CODE_GEN_PROMPT = `You are FlutterForge AI Agent, an elite full-stack Flutter and Supabase architect.
You design and generate production-grade Flutter applications integrated with Supabase.

### OUTPUT FORMAT — CRITICAL:
Each file MUST be in a markdown code block with filepath="..." attribute:
\`\`\`dart filepath="lib/main.dart"
// file content here
\`\`\`

### PRINCIPLES:
1. Clean Architecture with feature-first structure
2. Supabase auth, RLS, real-time subscriptions
3. Material 3 design with proper theming
4. Complete, compilable code — no placeholders
5. Include pubspec.yaml, main.dart, all screens, models, services

### PREVIEW FILE — MOST CRITICAL OUTPUT:
You MUST generate a file with filepath="preview/index.html" — a self-contained, fully interactive HTML page that renders a pixel-perfect visual preview of the app in a browser iframe. This is the #1 deliverable. It will be shown to the user immediately after generation.

The preview/index.html requirements:
- MUST be a complete HTML document with ALL CSS and JavaScript inline (no external file dependencies)
- MUST visually replicate the Flutter app's actual UI — same colors, layout, typography, spacing, icons
- MUST include ALL screens as switchable views with working bottom navigation or tab bar
- MUST be fully interactive: buttons clickable, forms submittable, navigation working, toggles toggleable
- MUST include realistic mock data that fills every screen with content (not empty placeholders)
- MUST use the exact same color scheme and theme as the Flutter app (extract from ThemeData)
- MUST be mobile-first, responsive, and work in a 393x852 iframe via srcDoc
- MUST include smooth CSS transitions/animations for screen switches, hover states, and interactions
- MUST include loading skeletons, error states, and empty states where appropriate
- MUST use Google Fonts (Inter or Roboto) loaded via CDN link tag
- MUST NOT load any external resources except CDN links (fonts, Supabase JS)
- Access Supabase via window.SUPABASE_URL and window.SUPABASE_ANON_KEY if needed
- The preview should look like a REAL app, not a wireframe or mockup. Use proper shadows, rounded corners, gradients, and spacing.
- Include a status bar (9:41, signal/wifi/battery icons) at the top
- Include a bottom navigation bar with icons (use emoji or inline SVG) for each screen
- Each screen should have an AppBar with the screen title and action buttons
- Use realistic content: product cards with images (use placeholder gradients), list items with avatars, stat cards with trend indicators, charts with CSS bars

Example structure for preview/index.html:
\`\`\`html filepath="preview/index.html"
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>App Preview</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    /* Complete CSS with CSS variables for theming */
    /* Card styles, list styles, button styles, nav styles */
    /* Animations and transitions */
  </style>
</head>
<body>
  <!-- Status bar -->
  <!-- App bar -->
  <!-- Screen containers (one active, rest hidden) -->
  <!-- Bottom navigation -->
  <script>
    /* Screen switching logic */
    /* Form handling */
    /* Interactive elements */
  </script>
</body>
</html>
\`\`\``;

const CHAT_PROMPT = `You are FlutterForge AI, an expert Flutter and Supabase development assistant.
You help users with questions about Flutter, Dart, Supabase, app architecture, debugging, and best practices.
Be concise, helpful, and friendly. Use markdown formatting with code snippets when relevant.
When a user wants to build or modify their app, encourage them to describe it and you'll generate the code.`;

const MANIFEST_PROMPT = `You are FlutterForge AI architecture planner. Analyze the user's app request and produce a file manifest — a JSON list of ALL files needed to build a complete, production-grade Flutter + Supabase application.

Think big. A real app needs 25-40+ files. Consider every layer:
- Core: main.dart, app.dart, router, theme, constants, config
- Models: one model file per data entity
- Services: Supabase client, auth service, data service, API services
- Screens: one file per screen (home, detail, settings, profile, auth, etc.)
- Widgets: reusable widgets, cards, lists, forms, dialogs
- State: providers, controllers, state management files
- Database: SQL migration with tables + RLS policies
- Config: pubspec.yaml, analysis_options.yaml
- Preview: preview/index.html (interactive HTML preview of the entire app)
- Platform: Android/iOS config files
- README.md

Output ONLY a JSON object (no markdown, no code blocks):
{
  "files": [
    {"path": "lib/main.dart", "batch": "core", "description": "App entry point with Supabase init"},
    {"path": "lib/core/theme/app_theme.dart", "batch": "core", "description": "Material 3 theme config"},
    {"path": "lib/screens/home/home_screen.dart", "batch": "screens_1", "description": "Home dashboard with stats"},
    {"path": "preview/index.html", "batch": "preview", "description": "Interactive HTML preview"}
  ],
  "screens": ["HomeScreen", "SettingsScreen", "ProfileScreen"],
  "features": ["feature1", "feature2"],
  "tables": [{"name": "items", "columns": ["id", "title", "user_id"]}]
}

Rules:
- Generate 25-40 file entries minimum
- Assign each file to a batch: "core", "preview", or "screens_N" (2-3 screens per batch)
- Each file needs a clear description of what it contains
- Include preview/index.html in the "preview" batch
- Include SQL migration file
- Include pubspec.yaml
- Output ONLY the JSON, no other text`;

const FREE_MODEL_CHAIN = [
  "nvidia/nemotron-3-ultra-550b-a55b:free"
];

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function parseFilesFromMarkdown(aiContent: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const codeBlockRegex = /```(?:dart|yaml|sql|json|swift|kotlin|xml|gradle|html|css|javascript|js|ts|markdown|md)?\s+filepath="([^"]+)"\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRegex.exec(aiContent)) !== null) {
    files.push({ path: match[1], content: match[2].trim() });
  }

  if (files.length === 0) {
    const codeBlockMatch = aiContent.match(/<code_block>\s*([\s\S]*?)\s*<\/code_block>/);
    if (codeBlockMatch) {
      try {
        const parsed = JSON.parse(codeBlockMatch[1]);
        if (parsed.files && Array.isArray(parsed.files)) {
          files.push(...parsed.files);
        }
      } catch {
        const jsonMatch = codeBlockMatch[1].match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.files && Array.isArray(parsed.files)) {
              files.push(...parsed.files);
            }
          } catch { /* give up */ }
        }
      }
    }
  }

  if (files.length === 0) {
    const jsonMatch = aiContent.match(/\{[\s\S]*"files"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.files && Array.isArray(parsed.files)) {
          files.push(...parsed.files);
        }
      } catch { /* give up */ }
    }
  }

  return files;
}

function generateDefaultManifest(prompt: string): {
  files: Array<{ path: string; batch: string; description: string }>;
  screens: string[];
  features: string[];
  tables: Array<{ name: string; columns: string[] }>;
} {
  const lower = prompt.toLowerCase();
  const isEcommerce = /shop|cart|product|order|checkout|ecommerce|store/.test(lower);
  const isChat = /chat|message|conversation/.test(lower);
  const isFinance = /finance|wallet|transaction|budget|expense|balance/.test(lower);
  const isFood = /food|restaurant|delivery|menu/.test(lower);
  const isTask = /task|todo|kanban|board/.test(lower);
  const isSocial = /social|feed|post|like|comment|follow/.test(lower);

  const appName = "FlutterForgeApp";
  const screens = isEcommerce
    ? ["HomeScreen", "ProductDetailScreen", "CartScreen", "CheckoutScreen", "OrdersScreen", "ProfileScreen", "SettingsScreen"]
    : isChat
    ? ["ChatListScreen", "ChatScreen", "NewChatScreen", "SettingsScreen", "ProfileScreen"]
    : isFinance
    ? ["DashboardScreen", "TransactionsScreen", "AddTransactionScreen", "BudgetScreen", "SettingsScreen", "ProfileScreen"]
    : isFood
    ? ["HomeScreen", "RestaurantDetailScreen", "CartScreen", "OrderTrackingScreen", "ProfileScreen", "SettingsScreen"]
    : isTask
    ? ["BoardScreen", "TaskDetailScreen", "CreateTaskScreen", "CalendarScreen", "SettingsScreen", "ProfileScreen"]
    : isSocial
    ? ["FeedScreen", "PostDetailScreen", "CreatePostScreen", "ProfileScreen", "SearchScreen", "SettingsScreen"]
    : ["HomeScreen", "DetailScreen", "SettingsScreen", "ProfileScreen"];

  const tables = isEcommerce
    ? [
        { name: "products", columns: ["id", "title", "description", "price", "image_url", "category", "stock"] },
        { name: "cart_items", columns: ["id", "user_id", "product_id", "quantity"] },
        { name: "orders", columns: ["id", "user_id", "total", "status", "created_at"] },
        { name: "order_items", columns: ["id", "order_id", "product_id", "quantity", "price"] },
      ]
    : isChat
    ? [
        { name: "conversations", columns: ["id", "user_id", "title", "created_at"] },
        { name: "messages", columns: ["id", "conversation_id", "role", "content", "created_at"] },
      ]
    : isFinance
    ? [
        { name: "transactions", columns: ["id", "user_id", "amount", "type", "category", "description", "created_at"] },
        { name: "budgets", columns: ["id", "user_id", "category", "limit", "period"] },
      ]
    : isTask
    ? [
        { name: "tasks", columns: ["id", "user_id", "title", "description", "status", "priority", "due_date"] },
        { name: "columns", columns: ["id", "board_id", "name", "position"] },
      ]
    : isSocial
    ? [
        { name: "posts", columns: ["id", "user_id", "content", "image_url", "likes_count", "created_at"] },
        { name: "comments", columns: ["id", "post_id", "user_id", "content", "created_at"] },
        { name: "likes", columns: ["id", "post_id", "user_id"] },
      ]
    : [{ name: "items", columns: ["id", "user_id", "title", "description", "created_at"] }];

  const features = isEcommerce
    ? ["Product catalog", "Shopping cart", "Checkout", "Order history", "User auth", "Search & filter"]
    : isChat
    ? ["AI chat", "Conversation history", "Streaming responses", "Markdown rendering", "User auth"]
    : isFinance
    ? ["Transaction tracking", "Budget management", "P&L charts", "Category analytics", "User auth"]
    : isFood
    ? ["Restaurant browsing", "Menu viewing", "Cart & ordering", "Delivery tracking", "User auth"]
    : isTask
    ? ["Kanban board", "Task CRUD", "Drag & drop", "Calendar view", "User auth"]
    : isSocial
    ? ["Feed", "Create post", "Like & comment", "User profiles", "Search", "User auth"]
    : ["CRUD operations", "User auth", "Dashboard", "Settings"];

  // Build file list
  const files: Array<{ path: string; batch: string; description: string }> = [
    { path: "lib/main.dart", batch: "core", description: "App entry point with Supabase initialization" },
    { path: "lib/app.dart", batch: "core", description: "Material app widget with theme and router" },
    { path: "lib/core/router/app_router.dart", batch: "core", description: "GoRouter configuration with all routes" },
    { path: "lib/core/theme/app_theme.dart", batch: "core", description: "Material 3 theme with light/dark modes" },
    { path: "lib/core/constants/app_constants.dart", batch: "core", description: "App constants and configuration" },
    { path: "lib/core/services/supabase_service.dart", batch: "core", description: "Supabase client singleton" },
    { path: "lib/core/services/auth_service.dart", batch: "core", description: "Authentication service with Supabase" },
    { path: "lib/core/models/user_model.dart", batch: "core", description: "User data model" },
    { path: "pubspec.yaml", batch: "core", description: "Flutter project dependencies" },
    { path: "analysis_options.yaml", batch: "core", description: "Dart analyzer configuration" },
    { path: "supabase/migrations/001_initial_schema.sql", batch: "core", description: "Database schema with RLS policies" },
    { path: "README.md", batch: "core", description: "Project documentation" },
  ];

  // Add model files
  for (const table of tables) {
    const modelName = table.name.replace(/s$/, "");
    files.push({
      path: `lib/core/models/${modelName}_model.dart`,
      batch: "models",
      description: `${modelName} data model with fromJson/toJson`,
    });
  }

  // Add service files
  files.push({
    path: "lib/core/services/data_service.dart",
    batch: "models",
    description: "Generic CRUD data service using Supabase",
  });

  // Add screen files (2 per batch)
  for (let i = 0; i < screens.length; i++) {
    const batchName = `screens_${Math.floor(i / 2) + 1}`;
    const snakeName = screens[i].replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
    files.push({
      path: `lib/screens/${snakeName.split("_").slice(0, -1).join("_")}/${snakeName}.dart`,
      batch: batchName,
      description: `${screens[i]} with full UI and state management`,
    });
  }

  // Add reusable widgets
  files.push(
    { path: "lib/widgets/app_button.dart", batch: "widgets", description: "Reusable styled button widget" },
    { path: "lib/widgets/app_card.dart", batch: "widgets", description: "Reusable card widget" },
    { path: "lib/widgets/loading_widget.dart", batch: "widgets", description: "Loading skeleton widget" },
    { path: "lib/widgets/error_widget.dart", batch: "widgets", description: "Error state widget" },
    { path: "lib/widgets/empty_state_widget.dart", batch: "widgets", description: "Empty state widget" },
  );

  // Add state management
  files.push({
    path: "lib/core/state/app_state.dart",
    batch: "widgets",
    description: "App-level state management",
  });

  // Add auth screens
  files.push(
    { path: "lib/screens/auth/login_screen.dart", batch: "auth", description: "Login screen with email/password" },
    { path: "lib/screens/auth/signup_screen.dart", batch: "auth", description: "Signup screen with form validation" },
    { path: "lib/screens/auth/forgot_password_screen.dart", batch: "auth", description: "Password reset screen" },
  );

  // Add preview
  files.push({
    path: "preview/index.html",
    batch: "preview",
    description: "Interactive HTML preview of the entire app with all screens, navigation, and mock data",
  });

  return { files, screens, features, tables };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const openRouterKey = req.headers.get("X-OpenRouter-Key") || Deno.env.get("OPENROUTER_API_KEY");
    const requestedModel = req.headers.get("X-OpenRouter-Model");

    if (!openRouterKey) {
      return new Response(JSON.stringify({ error: "Missing OpenRouter API key." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { messages, files, mode, chatMode, planMode, planData, parallel } = await req.json();

    // ── PLAN MODE: Generate a file manifest for batch generation ──
    if (planMode) {
      const planConversationMessages: Array<{ role: string; content: string }> = [
        { role: "system", content: MANIFEST_PROMPT },
      ];

      const fileContext = files && files.length > 0
        ? files.slice(0, 10).map((f: { path: string }) => f.path).join(", ")
        : "(empty project)";

      planConversationMessages.push({
        role: "system",
        content: `Existing files: ${fileContext}. Mode: ${mode || "new"}.`,
      });

      for (const msg of messages) {
        planConversationMessages.push({ role: msg.role, content: msg.content });
      }

      const planStream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const send = (obj: unknown) => controller.enqueue(encoder.encode(sseData(obj)));

          send({ type: "status", message: "Analyzing request and generating plan..." });

          let lastError = "";
          let succeeded = false;

          for (const model of (requestedModel ? [requestedModel, ...FREE_MODEL_CHAIN] : FREE_MODEL_CHAIN)) {
            if (succeeded) break;

            try {
              send({ type: "status", message: `Planning with model: ${model}...` });

              const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${openRouterKey}`,
                  "HTTP-Referer": "https://flutterforge.app",
                  "X-Title": "FlutterForge AI",
                },
                body: JSON.stringify({
                  model,
                  messages: planConversationMessages,
                  temperature: 0.2,
                  max_tokens: 2000,
                  stream: false,
                }),
              });

              if (!response.ok) {
                const errText = await response.text();
                lastError = `${model}: ${response.status} ${errText.slice(0, 100)}`;
                send({ type: "warning", message: `Model ${model} failed (${response.status}), trying next...` });
                continue;
              }

              const data = await response.json();
              const content = data.choices?.[0]?.message?.content || "";

              if (content.trim().length > 0) {
                send({ type: "complete", plan: content, model });
                succeeded = true;
                break;
              } else {
                lastError = `${model}: Empty response`;
                send({ type: "warning", message: `Model ${model} returned empty, trying next...` });
              }
            } catch (e) {
              lastError = `${model}: ${String(e).slice(0, 100)}`;
              send({ type: "warning", message: `Model ${model} error, trying next...` });
              continue;
            }
          }

          if (!succeeded) {
            send({ type: "error", error: `All models failed. Last error: ${lastError}` });
          }

          controller.close();
        },
      });

      return new Response(planStream, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // ── PARALLEL GENERATION MODE: split plan into batches, generate concurrently ──
    if (parallel && planData && !chatMode) {
      const screens: Array<{ name: string; description: string }> = planData.screens || [];
      const features: string[] = planData.features || [];
      const tables: Array<{ name: string; columns: string[] }> = planData.tables || [];

      // Build batch prompts — each batch handles a subset of screens
      const BATCH_SIZE = 2;
      const batches: Array<{ name: string; screens: typeof screens; instructions: string }> = [];

      // Batch 1: Core infrastructure (main.dart, router, theme, models, services, schema)
      batches.push({
        name: 'core',
        screens: [],
        instructions: `Generate the core infrastructure files: main.dart, app router (GoRouter), theme configuration, Supabase client setup, data models, and database schema SQL with RLS policies. Also generate pubspec.yaml with all required dependencies. Also generate a COMPLETE preview/index.html — this is the most important file. It must be a fully interactive, self-contained HTML page with inline CSS and JS that visually replicates the entire app with all screens, bottom navigation, mock data, and smooth animations. Do NOT show a loading state — generate the full app preview with all screens from the plan.`,
      });

      // Subsequent batches: 2 screens each
      for (let i = 0; i < screens.length; i += BATCH_SIZE) {
        const batchScreens = screens.slice(i, i + BATCH_SIZE);
        batches.push({
          name: `screens_${i}`,
          screens: batchScreens,
          instructions: `Generate the following screens with full UI, state management, and Supabase integration:\n${batchScreens.map((s) => `- ${s.name}: ${s.description}`).join('\n')}\n\nAlso update preview/index.html to add these screens with full interactive UI, mock data, and navigation. Each screen must have realistic content, proper styling matching the app theme, and working interactions.`,
        });
      }

      const parallelStream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const send = (obj: unknown) => controller.enqueue(encoder.encode(sseData(obj)));

          send({ type: "status", message: `Parallel generation: ${batches.length} batches for ${screens.length} screens` });

          // Build conversation context shared across batches
          const fileContext = files && files.length > 0
            ? files.slice(0, 10).map((f: { path: string }) => f.path).join(", ")
            : "(empty project)";

          const lastUserMsg = messages.filter((m: { role: string }) => m.role === "user").pop();

          // Run all batches concurrently
          const batchPromises = batches.map(async (batch, batchIdx) => {
            const batchMessages: Array<{ role: string; content: string }> = [
              { role: "system", content: CODE_GEN_PROMPT },
              { role: "system", content: `Existing files: ${fileContext}. Project mode: ${mode}.` },
              { role: "system", content: `Features to implement: ${features.join(", ")}. Database tables: ${tables.map((t) => t.name).join(", ")}.` },
            ];

            if (lastUserMsg) {
              batchMessages.push({ role: "user", content: lastUserMsg.content });
            }

            batchMessages.push({
              role: "user",
              content: `${batch.instructions}\n\nIMPORTANT: Use filepath="path/to/file" format in code blocks. Generate complete, production-ready files.`,
            });

            for (const model of (requestedModel ? [requestedModel, ...FREE_MODEL_CHAIN] : FREE_MODEL_CHAIN)) {
              try {
                send({ type: "status", message: `Batch ${batchIdx + 1}/${batches.length} (${batch.name}) — trying ${model}...` });

                const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${openRouterKey}`,
                    "HTTP-Referer": "https://flutterforge.app",
                    "X-Title": "FlutterForge AI",
                  },
                  body: JSON.stringify({
                    model,
                    messages: batchMessages,
                    temperature: 0.15,
                    max_tokens: 32000,
                    stream: false,
                  }),
                });

                if (!response.ok) {
                  send({ type: "warning", message: `Batch ${batch.name} model ${model} failed (${response.status})` });
                  continue;
                }

                const data = await response.json();
                const content = data.choices?.[0]?.message?.content || "";
                const batchFiles = parseFilesFromMarkdown(content);

                if (batchFiles.length > 0) {
                  send({ type: "batch_complete", batch: batch.name, fileCount: batchFiles.length, files: batchFiles, model });
                  return batchFiles;
                }
              } catch {
                send({ type: "warning", message: `Batch ${batch.name} model ${model} error, trying next...` });
                continue;
              }
            }

            send({ type: "warning", message: `Batch ${batch.name} failed on all models` });
            return [];
          });

          const results = await Promise.all(batchPromises);
          const allFiles = results.flat();

          // Deduplicate by path (later batches override earlier ones for preview/index.html)
          const fileMap = new Map<string, { path: string; content: string }>();
          for (const f of allFiles) {
            fileMap.set(f.path, f);
          }

          const dedupedFiles = Array.from(fileMap.values());

          if (dedupedFiles.length > 0) {
            send({ type: "complete", summary: `Parallel generation: ${dedupedFiles.length} files from ${batches.length} batches`, files: dedupedFiles, model: "parallel" });
          } else {
            send({ type: "error", error: "Parallel generation produced no files" });
          }

          controller.close();
        },
      });

      return new Response(parallelStream, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // ── CHAT MODE: streaming chat responses ──
    if (chatMode) {
      const systemPrompt = CHAT_PROMPT;
      const conversationMessages: Array<{ role: string; content: string }> = [
        { role: "system", content: systemPrompt },
      ];

      if (files && files.length > 0) {
        const fileList = files.slice(0, 20).map((f: { path: string }) => f.path).join(", ");
        conversationMessages.push({
          role: "system",
          content: `Current project files: ${fileList}`,
        });
      }

      for (const msg of messages) {
        conversationMessages.push({ role: msg.role, content: msg.content });
      }

      const modelChain = requestedModel ? [requestedModel, ...FREE_MODEL_CHAIN] : FREE_MODEL_CHAIN;
      const maxTokens = 4000;

      const chatStream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const send = (obj: unknown) => controller.enqueue(encoder.encode(sseData(obj)));

          send({ type: "status", message: "Thinking..." });

          let lastError = "";
          let succeeded = false;

          for (const model of modelChain) {
            if (succeeded) break;

            try {
              send({ type: "status", message: `Trying model: ${model}...` });

              const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${openRouterKey}`,
                  "HTTP-Referer": "https://flutterforge.app",
                  "X-Title": "FlutterForge AI",
                },
                body: JSON.stringify({
                  model,
                  messages: conversationMessages,
                  temperature: 0.3,
                  max_tokens: maxTokens,
                  stream: true,
                }),
              });

              if (!response.ok) {
                const errText = await response.text();
                lastError = `${model}: ${response.status} ${errText.slice(0, 100)}`;
                send({ type: "warning", message: `Model ${model} failed (${response.status}), trying next...` });
                continue;
              }

              if (!response.body) {
                lastError = `${model}: No response body`;
                continue;
              }

              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let fullContent = "";
              let buffer = "";

              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                  if (!line.startsWith("data: ")) continue;
                  const data = line.slice(6).trim();
                  if (data === "[DONE]") continue;

                  try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta?.content;
                    if (delta) {
                      fullContent += delta;
                      send({ type: "token", content: delta });
                    }
                  } catch {
                    // skip malformed chunks
                  }
                }
              }

              if (fullContent.trim().length > 0) {
                send({ type: "complete", content: fullContent, model });
                succeeded = true;
                break;
              } else {
                lastError = `${model}: Empty response`;
                send({ type: "warning", message: `Model ${model} returned empty, trying next...` });
              }
            } catch (e) {
              lastError = `${model}: ${String(e).slice(0, 100)}`;
              send({ type: "warning", message: `Model ${model} error, trying next...` });
              continue;
            }
          }

          if (!succeeded) {
            send({ type: "error", error: `All models failed. Last error: ${lastError}` });
          }

          controller.close();
        },
      });

      return new Response(chatStream, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // ── AUTO-MANIFEST BATCH GENERATION ──
    // When no planData is provided, first generate a file manifest, then batch-generate all files in parallel.
    // This ensures 25-40+ files per app (like Lovable) instead of 9 files from a single shot.

    const lastUserMsg = messages.filter((m: { role: string }) => m.role === "user").pop();
    const userPrompt = lastUserMsg?.content || "Create a Flutter app";
    const fileContext = files && files.length > 0
      ? files.slice(0, 10).map((f: { path: string }) => f.path).join(", ")
      : "(empty project)";

    const manifestStream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (obj: unknown) => controller.enqueue(encoder.encode(sseData(obj)));

        // Phase 1: Generate file manifest
        send({ type: "status", message: "Planning file architecture..." });

        let manifest: { files: Array<{ path: string; batch: string; description: string }>; screens: string[]; features: string[]; tables: Array<{ name: string; columns: string[] }> } | null = null;
        let manifestError = "";

        for (const model of (requestedModel ? [requestedModel, ...FREE_MODEL_CHAIN] : FREE_MODEL_CHAIN)) {
          try {
            send({ type: "status", message: `Architecture planning with ${model}...` });

            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${openRouterKey}`,
                "HTTP-Referer": "https://flutterforge.app",
                "X-Title": "FlutterForge AI",
              },
              body: JSON.stringify({
                model,
                messages: [
                  { role: "system", content: MANIFEST_PROMPT },
                  { role: "system", content: `Existing files: ${fileContext}. Mode: ${mode || "new"}.` },
                  { role: "user", content: userPrompt },
                ],
                temperature: 0.2,
                max_tokens: 4000,
                stream: false,
              }),
            });

            if (!response.ok) {
              manifestError = `${model}: ${response.status}`;
              send({ type: "warning", message: `Manifest model ${model} failed (${response.status}), trying next...` });
              continue;
            }

            const data = await response.json();
            const content = data.choices?.[0]?.message?.content || "";

            // Parse manifest JSON
            const cleaned = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
            const parsed = JSON.parse(cleaned);

            if (parsed.files && Array.isArray(parsed.files) && parsed.files.length > 0) {
              manifest = parsed;
              send({ type: "status", message: `Architecture ready: ${parsed.files.length} files planned across ${new Set(parsed.files.map((f: { batch: string }) => f.batch)).size} batches` });
              break;
            } else {
              manifestError = `${model}: No files in manifest`;
            }
          } catch (e) {
            manifestError = `${model}: ${String(e).slice(0, 100)}`;
            send({ type: "warning", message: `Manifest model ${model} error, trying next...` });
            continue;
          }
        }

        // If manifest failed, fall back to a hardcoded manifest based on the prompt
        if (!manifest) {
          send({ type: "warning", message: "Manifest generation failed — using default architecture" });
          manifest = generateDefaultManifest(userPrompt);
        }

        // Phase 2: Group files by batch and generate in parallel
        const batchGroups = new Map<string, Array<{ path: string; description: string }>>();
        for (const file of manifest.files) {
          const batch = file.batch || "misc";
          if (!batchGroups.has(batch)) batchGroups.set(batch, []);
          batchGroups.get(batch)!.push({ path: file.path, description: file.description });
        }

        const batches = Array.from(batchGroups.entries()).map(([name, fileList]) => ({ name, files: fileList }));
        send({ type: "status", message: `Generating ${manifest.files.length} files in ${batches.length} parallel batches...` });

        const features = manifest.features || [];
        const tables = manifest.tables || [];
        const screensList = manifest.screens || [];

        const batchPromises = batches.map(async (batch, batchIdx) => {
          const batchFileList = batch.files.map((f) => `- ${f.path}: ${f.description}`).join("\n");

          const batchMessages: Array<{ role: string; content: string }> = [
            { role: "system", content: CODE_GEN_PROMPT },
            { role: "system", content: `Existing files: ${fileContext}. Project mode: ${mode || "new"}.` },
            { role: "system", content: `Features: ${features.join(", ")}. Database tables: ${tables.map((t) => t.name).join(", ")}. Screens: ${screensList.join(", ")}.` },
            { role: "user", content: userPrompt },
            {
              role: "user",
              content: `Generate the following files for this batch. Each file MUST be complete and production-ready.\n\nFiles to generate:\n${batchFileList}\n\nIMPORTANT: Use filepath="path/to/file" format in code blocks. Generate complete, production-ready files with no placeholders or TODOs.`,
            },
          ];

          for (const model of (requestedModel ? [requestedModel, ...FREE_MODEL_CHAIN] : FREE_MODEL_CHAIN)) {
            try {
              send({ type: "status", message: `Batch ${batchIdx + 1}/${batches.length} (${batch.name}) — generating with ${model}...` });

              const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${openRouterKey}`,
                  "HTTP-Referer": "https://flutterforge.app",
                  "X-Title": "FlutterForge AI",
                },
                body: JSON.stringify({
                  model,
                  messages: batchMessages,
                  temperature: 0.15,
                  max_tokens: 32000,
                  stream: false,
                }),
              });

              if (!response.ok) {
                send({ type: "warning", message: `Batch ${batch.name} model ${model} failed (${response.status})` });
                continue;
              }

              const data = await response.json();
              const content = data.choices?.[0]?.message?.content || "";
              const batchFiles = parseFilesFromMarkdown(content);

              if (batchFiles.length > 0) {
                send({ type: "batch_complete", batch: batch.name, fileCount: batchFiles.length, files: batchFiles, model });
                return batchFiles;
              }
            } catch {
              send({ type: "warning", message: `Batch ${batch.name} model ${model} error, trying next...` });
              continue;
            }
          }

          send({ type: "warning", message: `Batch ${batch.name} failed on all models` });
          return [];
        });

        const results = await Promise.all(batchPromises);
        const allFiles = results.flat();

        // Deduplicate by path (later batches override earlier ones for preview/index.html)
        const fileMap = new Map<string, { path: string; content: string }>();
        for (const f of allFiles) {
          fileMap.set(f.path, f);
        }

        const dedupedFiles = Array.from(fileMap.values());

        if (dedupedFiles.length > 0) {
          send({ type: "complete", summary: `Generated ${dedupedFiles.length} files from ${batches.length} batches`, files: dedupedFiles, model: "auto-manifest" });
        } else {
          send({ type: "error", error: "Generation produced no files" });
        }

        controller.close();
      },
    });

    return new Response(manifestStream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Server error: ${String(err)}` }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
