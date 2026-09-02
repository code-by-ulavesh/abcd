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

### PREVIEW FILE — CRITICAL:
You MUST also generate a file with filepath="preview/index.html" — a self-contained HTML page that renders a visual preview of the app in a browser iframe. This file:
- Must be a complete HTML document with inline CSS and JavaScript
- Must visually represent the Flutter app's UI (colors, layout, screens, navigation)
- Must use the same color scheme and theme as the Flutter app
- Must include all screens as switchable views (bottom nav or tabs)
- Must be fully functional in an iframe via srcDoc (no external file dependencies)
- Must include realistic mock data to demonstrate the UI
- Must be responsive (mobile-first design)
- Must include loading skeletons, error states, and empty states where appropriate
- Must NOT load any external resources except CDN links (Supabase JS, fonts)
- Access Supabase via window.SUPABASE_URL and window.SUPABASE_ANON_KEY if needed

Example structure for preview/index.html:
\`\`\`html filepath="preview/index.html"
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>App Preview</title>
  <style>/* All CSS inline */</style>
</head>
<body>
  <!-- App UI here -->
  <script>/* All JS inline */</script>
</body>
</html>
\`\`\``;

const CHAT_PROMPT = `You are FlutterForge AI, an expert Flutter and Supabase development assistant.
You help users with questions about Flutter, Dart, Supabase, app architecture, debugging, and best practices.
Be concise, helpful, and friendly. Use markdown formatting with code snippets when relevant.
When a user wants to build or modify their app, encourage them to describe it and you'll generate the code.`;

const PLAN_PROMPT = `You are FlutterForge AI planning agent. Analyze the user's app request and produce a plan for building a Flutter + Supabase application.

Output a JSON object (no markdown, no code blocks, just raw JSON) with this shape:
{
  "summary": "A 1-2 sentence description of what will be built",
  "features": ["feature 1", "feature 2", ...],
  "screens": [{"name": "HomeScreen", "description": "Main dashboard"}],
  "tables": [{"name": "items", "columns": ["id", "title", "user_id"]}],
  "questions": ["A clarifying question for the user", ...],
  "estimatedFiles": 15,
  "theme": {"primaryColor": "#3B82F6", "mode": "light"}
}

Rules:
- If the user's request is clear and detailed, return an empty "questions" array.
- If the request is vague or missing key details (auth method, target platform, data model, etc.), ask 1-3 focused clarifying questions.
- Keep "summary" under 2 sentences.
- List 3-8 features.
- List all screens the app needs.
- List database tables with their key columns.
- Estimate total file count realistically.
- Output ONLY the JSON, no text before or after.`;

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

    // ── PLAN MODE: Generate a plan + clarifying questions ──
    if (planMode) {
      const planConversationMessages: Array<{ role: string; content: string }> = [
        { role: "system", content: PLAN_PROMPT },
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
        instructions: `Generate the core infrastructure files: main.dart, app router (GoRouter), theme configuration, Supabase client setup, data models, and database schema SQL with RLS policies. Also generate pubspec.yaml with all required dependencies. Also generate preview/index.html showing a loading state.`,
      });

      // Subsequent batches: 2 screens each
      for (let i = 0; i < screens.length; i += BATCH_SIZE) {
        const batchScreens = screens.slice(i, i + BATCH_SIZE);
        batches.push({
          name: `screens_${i}`,
          screens: batchScreens,
          instructions: `Generate the following screens with full UI, state management, and Supabase integration:\n${batchScreens.map((s) => `- ${s.name}: ${s.description}`).join('\n')}\n\nAlso update preview/index.html to include these screens in the navigation.`,
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

    const systemPrompt = chatMode ? CHAT_PROMPT : CODE_GEN_PROMPT;

    const conversationMessages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
    ];

    if (files && files.length > 0 && !chatMode) {
      if (mode === "new") {
        const fileList = files.map((f: { path: string }) => f.path).join("\n");
        conversationMessages.push({
          role: "system",
          content: `Existing project files:\n${fileList}\n\nGenerate a complete new project, overwriting all files as needed.`,
        });
      } else {
        const fileContext = files
          .slice(0, 20)
          .map((f: { path: string; content: string }) => `--- ${f.path} ---\n${f.content.slice(0, 3000)}`)
          .join("\n\n");
        conversationMessages.push({
          role: "system",
          content: `Here are the current project files:\n\n${fileContext}`,
        });
      }
    }

    if (chatMode && files && files.length > 0) {
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

    const maxTokens = chatMode ? 4000 : 64000;

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (obj: unknown) => controller.enqueue(encoder.encode(sseData(obj)));

        send({ type: "status", message: chatMode ? "Thinking..." : "Starting generation..." });

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
                temperature: chatMode ? 0.3 : 0.15,
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

            if (chatMode) {
              // Chat mode — return the text content directly
              if (fullContent.trim().length > 0) {
                send({
                  type: "complete",
                  content: fullContent,
                  model,
                });
                succeeded = true;
                break;
              } else {
                lastError = `${model}: Empty response`;
                send({ type: "warning", message: `Model ${model} returned empty, trying next...` });
              }
            } else {
              // Code generation mode — parse files from content
              const parsedFiles = parseFilesFromMarkdown(fullContent);

              if (parsedFiles.length > 0) {
                send({
                  type: "complete",
                  summary: `Generated ${parsedFiles.length} files`,
                  files: parsedFiles,
                  model,
                });
                succeeded = true;
                break;
              } else {
                lastError = `${model}: No files parsed from output`;
                send({ type: "warning", message: `Model ${model} produced no parseable files, trying next...` });
              }
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

    return new Response(stream, {
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
