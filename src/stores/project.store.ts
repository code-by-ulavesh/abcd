import { create } from 'zustand';
import { supabase } from '@/services/supabase';
import type { Project, ProjectFile, ProjectVersion, AIConversation, AIMessage, GenerationTask, Build, Dependency, Deployment, FileChange, AgentPlan } from '@/types';
import { useAuthStore } from './auth.store';
import { generateFlutterProjectFiles } from '@/utils/flutterTemplates';
import { FlutterSupabaseAgent, AgentContextBuilder, keyPool } from '@/agent';
import { usePreviewStore } from './preview.store';
import { useWorkspaceStore } from './workspace.store';

export const PLAN_LIMITS: Record<string, number> = {
  free: 5,
  pro: 100,
  team: Infinity,
};

export async function getMonthlyUsageCount(): Promise<number> {
  const user = useAuthStore.getState().user;
  if (!user) return 0;
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const { count, error } = await supabase
    .from('usage_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('event_type', 'generation')
    .gte('created_at', startOfMonth.toISOString());
  if (error) return 0;
  return count ?? 0;
}

export async function getUserPlan(): Promise<string> {
  const user = useAuthStore.getState().user;
  if (!user) return 'free';
  const { data } = await supabase
    .from('profiles')
    .select('plan')
    .eq('id', user.id)
    .maybeSingle();
  return data?.plan ?? 'free';
}

async function trackUsage(projectId: string, eventType: 'generation' | 'build' | 'deploy', model?: string, tokensUsed?: number): Promise<void> {
  const user = useAuthStore.getState().user;
  if (!user) return;
  await supabase.from('usage_events').insert({
    user_id: user.id,
    event_type: eventType,
    project_id: projectId,
    model,
    tokens_used: tokensUsed,
  });
}

const CHAT_SYSTEM_PROMPT = `You are FlutterForge AI, an expert Flutter and Supabase development assistant.
You help users with questions about Flutter, Dart, Supabase, app architecture, debugging, and best practices.
Be concise, helpful, and friendly. Use markdown formatting for code snippets.
When the user wants you to build or modify their app, tell them to describe what they want to build and you'll generate the code.`;

function isChatMessage(prompt: string, hasExistingFiles: boolean): boolean {
  const lower = prompt.toLowerCase().trim();
  // If it's the first message and we have no files, it's always a generation request
  if (!hasExistingFiles) return false;

  // Code generation signals
  const genSignals = [
    'build', 'create', 'generate', 'make', 'add', 'implement', 'fix', 'update',
    'modify', 'refactor', 'remove', 'delete', 'change', 'set up', 'setup',
    'integrate', 'connect', 'configure',
  ];
  // Chat signals — questions or conversational
  const chatSignals = [
    'how do i', 'how to', 'what is', 'what are', 'why', 'when should',
    'can you explain', 'explain', 'difference between', 'should i use',
    'best practice', 'help me understand', 'is it possible', 'do i need',
    'what does', 'tell me about', 'which is better', 'can i',
  ];

  // Strong chat signals: starts with a question word
  for (const signal of chatSignals) {
    if (lower.startsWith(signal)) return true;
  }

  // Very short messages with no generation keywords are likely chat
  if (lower.split(' ').length <= 4) {
    const hasGenSignal = genSignals.some((s) => lower.includes(s));
    if (!hasGenSignal) return true;
  }

  // Contains a question mark and no generation keywords
  if (lower.includes('?') && !lower.includes('build') && !lower.includes('create') && !lower.includes('generate')) {
    return true;
  }

  return false;
}

async function chatWithAI(
  messages: AIMessage[],
  files: ProjectFile[],
  onProgress?: (msg: string) => void,
  onToken?: (token: string) => void,
): Promise<string> {
  onProgress?.('Thinking...');

  let apiKey: string;
  try {
    apiKey = keyPool.getNextKey();
  } catch {
    apiKey = import.meta.env.VITE_OPENROUTER_API_KEY || '';
  }

  if (!apiKey) {
    return "I'd love to help, but no AI API keys are configured. Please add your OpenRouter API key in the settings.";
  }

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const edgeUrl = `${supabaseUrl}/functions/v1/ai-generate`;

  try {
    const response = await fetch(edgeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseAnonKey}`,
        'apikey': supabaseAnonKey,
        'X-OpenRouter-Key': apiKey,
      },
      body: JSON.stringify({
        messages: messages.slice(-10).map((m) => ({
          role: m.role,
          content: m.content,
        })),
        files: files.filter((f) => !f.is_directory).map((f) => ({
          path: f.path,
          content: f.content,
        })),
        chatMode: true,
      }),
    });

    if (response.ok && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';
      let hadError = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;

          try {
            const event = JSON.parse(data) as { type: string; message?: string; content?: string; error?: string };
            if (event.type === 'status' && event.message) {
              onProgress?.(event.message);
            } else if (event.type === 'token' && event.content) {
              fullContent += event.content;
              onToken?.(event.content);
            } else if (event.type === 'warning' && event.message) {
              onProgress?.(event.message);
            } else if (event.type === 'complete' && event.content) {
              fullContent = event.content;
            } else if (event.type === 'error' && event.error) {
              hadError = true;
              onProgress?.(`Error: ${event.error.slice(0, 60)}`);
            }
          } catch {
            // skip malformed SSE
          }
        }
      }

      if (!hadError && fullContent.trim().length > 0) {
        return fullContent;
      }
    }
  } catch (e) {
    onProgress?.(`Edge stream failed (${(e as Error).message?.slice(0, 40)}), trying direct...`);
  }

  // Fallback: direct OpenRouter call (non-streaming)
  const conversationHistory = messages.slice(-10).map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  const fileList = files.filter((f) => !f.is_directory).map((f) => f.path).slice(0, 20).join(', ');
  const contextMsg = fileList
    ? `Current project files: ${fileList}`
    : 'No files in the project yet.';

  const llmMessages = [
    { role: 'system' as const, content: CHAT_SYSTEM_PROMPT },
    { role: 'system' as const, content: contextMsg },
    ...conversationHistory,
  ];

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://flutterforge.dev',
      'X-Title': 'FlutterForge AI',
    },
    body: JSON.stringify({
      model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      messages: llmMessages,
      temperature: 0.3,
      max_tokens: 4000,
    }),
  });

  if (!response.ok) {
    const fallbackResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://flutterforge.dev',
        'X-Title': 'FlutterForge AI',
      },
      body: JSON.stringify({
        model: 'poolside/laguna-s-2.1:free',
        messages: llmMessages,
        temperature: 0.3,
        max_tokens: 4000,
      }),
    });

    if (!fallbackResponse.ok) {
      throw new Error('AI service is temporarily unavailable. Please try again.');
    }

    const data = await fallbackResponse.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';
    onToken?.(content);
    return content;
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';
  onToken?.(content);
  return content;
}

interface ProjectState {
  projects: Project[];
  currentProject: Project | null;
  files: ProjectFile[];
  versions: ProjectVersion[];
  conversation: AIConversation | null;
  messages: AIMessage[];
  tasks: GenerationTask[];
  builds: Build[];
  dependencies: Dependency[];
  deployments: Deployment[];
  loading: boolean;
  error: string | null;
  pendingPlan: AgentPlan | null;
  planLoading: boolean;
  lastApprovedPlan: AgentPlan | null;

  loadProjects: () => Promise<void>;
  createProject: (data: { name: string; description: string; template: string; flutter_version?: string; state_management?: string; theme_mode?: string; platform?: string }) => Promise<Project | null>;
  updateProject: (id: string, data: Partial<Project>) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  duplicateProject: (id: string) => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  loadFiles: (projectId: string) => Promise<void>;
  saveFile: (projectId: string, path: string, content: string) => Promise<void>;
  createFile: (projectId: string, path: string, content: string, isDirectory?: boolean) => Promise<void>;
  deleteFile: (projectId: string, path: string) => Promise<void>;
  renameFile: (projectId: string, oldPath: string, newPath: string) => Promise<void>;
  loadConversation: (projectId: string) => Promise<void>;
  sendMessage: (projectId: string, content: string, onProgress?: (message: string) => void) => Promise<void>;
  requestPlan: (projectId: string, content: string, onProgress?: (message: string) => void) => Promise<void>;
  approvePlan: (projectId: string, onProgress?: (message: string) => void) => Promise<void>;
  rejectPlan: () => void;
  answerQuestions: (answers: Record<number, string>) => void;
  loadDependencies: (projectId: string) => Promise<void>;
  addDependency: (projectId: string, packageName: string, version: string) => Promise<void>;
  removeDependency: (projectId: string, packageId: string) => Promise<void>;
  loadVersions: (projectId: string) => Promise<void>;
  createVersion: (projectId: string, label: string, description: string) => Promise<void>;
  restoreVersion: (projectId: string, versionId: string) => Promise<void>;
  restoreFile: (projectId: string, filePath: string, content?: string) => Promise<void>;
  loadBuilds: (projectId: string) => Promise<void>;
  loadDeployments: (projectId: string) => Promise<void>;
  clearCurrent: () => void;
  clearError: () => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  currentProject: null,
  files: [],
  versions: [],
  conversation: null,
  messages: [],
  tasks: [],
  builds: [],
  dependencies: [],
  deployments: [],
  loading: false,
  error: null,
  pendingPlan: null,
  planLoading: false,
  lastApprovedPlan: null,

  loadProjects: async () => {
    const user = useAuthStore.getState().user;
    if (!user) return;
    set({ loading: true });
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false });
    if (error) {
      set({ loading: false, error: error.message });
      return;
    }
    set({ projects: (data as Project[]) ?? [], loading: false });
  },

  createProject: async (data) => {
    const user = useAuthStore.getState().user;
    if (!user) return null;
    set({ loading: true, error: null });
    const { data: project, error } = await supabase
      .from('projects')
      .insert({
        user_id: user.id,
        name: data.name,
        description: data.description,
        template: data.template,
        flutter_version: data.flutter_version ?? '3.24.0',
        state_management: data.state_management ?? 'provider',
        theme_mode: data.theme_mode ?? 'light',
        platform: data.platform ?? 'web',
        status: 'created',
      })
      .select('*')
      .single();
    if (error) {
      set({ loading: false, error: error.message });
      return null;
    }

    const starterFiles = generateFlutterProjectFiles(data.name, data.template);
    const { error: filesError } = await supabase.from('project_files').insert(
      starterFiles.map((file) => ({
        project_id: project.id,
        path: file.path,
        content: file.content ?? '',
        file_type: file.path.split('.').pop() ?? null,
        is_directory: false,
      })),
    );
    if (filesError) {
      set({ loading: false, error: `Project created, but starter files could not be saved: ${filesError.message}` });
      return null;
    }

    set((state) => ({ projects: [project as Project, ...state.projects], loading: false }));
    return project as Project;
  },

  updateProject: async (id, data) => {
    const { error } = await supabase.from('projects').update(data).eq('id', id);
    if (error) {
      set({ error: error.message });
      return;
    }
    set((state) => ({
      projects: state.projects.map((p) => (p.id === id ? { ...p, ...data } : p)),
      currentProject: state.currentProject?.id === id ? { ...state.currentProject, ...data } : state.currentProject,
    }));
  },

  deleteProject: async (id) => {
    await supabase.from('projects').delete().eq('id', id);
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== id),
      currentProject: state.currentProject?.id === id ? null : state.currentProject,
    }));
  },

  duplicateProject: async (id) => {
    const project = get().projects.find((p) => p.id === id);
    if (!project) return;
    const user = useAuthStore.getState().user;
    if (!user) return;
    const { data: newProject } = await supabase
      .from('projects')
      .insert({
        user_id: user.id,
        name: `${project.name} (Copy)`,
        description: project.description,
        template: project.template,
        flutter_version: project.flutter_version,
        state_management: project.state_management,
        theme_mode: project.theme_mode,
        platform: project.platform,
        status: 'created',
      })
      .select('*')
      .single();
    if (newProject) {
      const { data: files } = await supabase.from('project_files').select('*').eq('project_id', id);
      if (files && files.length > 0) {
        const fileInserts = files.map((f) => ({
          project_id: (newProject as Project).id,
          path: f.path,
          content: f.content,
          file_type: f.file_type,
          is_directory: f.is_directory,
        }));
        await supabase.from('project_files').insert(fileInserts);
      }
      set((state) => ({ projects: [newProject as Project, ...state.projects] }));
    }
  },

  loadProject: async (id) => {
    set({ loading: true });
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) {
      set({ loading: false, error: error?.message ?? 'Project not found' });
      return;
    }
    set({ currentProject: data as Project, loading: false });
    await get().loadFiles(id);
    await get().loadConversation(id);
    await get().loadDependencies(id);
    await get().loadVersions(id);
    await get().loadBuilds(id);
    await get().loadDeployments(id);
  },

  loadFiles: async (projectId) => {
    const { data, error } = await supabase
      .from('project_files')
      .select('*')
      .eq('project_id', projectId)
      .order('path', { ascending: true });
    if (error) {
      set({ error: error.message });
      return;
    }
    set({ files: (data as ProjectFile[]) ?? [] });
  },

  saveFile: async (projectId, path, content) => {
    const { error } = await supabase
      .from('project_files')
      .update({ content, updated_at: new Date().toISOString() })
      .eq('project_id', projectId)
      .eq('path', path);
    if (error) {
      set({ error: error.message });
      return;
    }
    set((state) => ({
      files: state.files.map((f) =>
        f.project_id === projectId && f.path === path ? { ...f, content } : f
      ),
    }));
  },

  createFile: async (projectId, path, content, isDirectory = false) => {
    const ext = path.split('.').pop() ?? '';
    const { data, error } = await supabase
      .from('project_files')
      .insert({
        project_id: projectId,
        path,
        content,
        file_type: ext,
        is_directory: isDirectory,
      })
      .select('*')
      .single();
    if (error) {
      set({ error: error.message });
      return;
    }
    set((state) => ({ files: [...state.files, data as ProjectFile] }));
  },

  deleteFile: async (projectId, path) => {
    await supabase
      .from('project_files')
      .delete()
      .eq('project_id', projectId)
      .eq('path', path);
    set((state) => ({
      files: state.files.filter((f) => !(f.project_id === projectId && f.path === path)),
    }));
  },

  renameFile: async (projectId, oldPath, newPath) => {
    await supabase
      .from('project_files')
      .update({ path: newPath, updated_at: new Date().toISOString() })
      .eq('project_id', projectId)
      .eq('path', oldPath);
    set((state) => ({
      files: state.files.map((f) =>
        f.project_id === projectId && f.path === oldPath ? { ...f, path: newPath } : f
      ),
    }));
  },

  loadConversation: async (projectId) => {
    const { data: conv } = await supabase
      .from('ai_conversations')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (conv) {
      set({ conversation: conv as AIConversation });
      const { data: msgs } = await supabase
        .from('ai_messages')
        .select('*')
        .eq('conversation_id', (conv as AIConversation).id)
        .order('created_at', { ascending: true });
      set({ messages: (msgs as AIMessage[]) ?? [] });
    } else {
      const { data: newConv } = await supabase
        .from('ai_conversations')
        .insert({ project_id: projectId, title: 'New Conversation' })
        .select('*')
        .single();
      set({ conversation: newConv as AIConversation, messages: [] });
    }
  },

  sendMessage: async (projectId, content, onProgress) => {
    const conv = get().conversation;
    if (!conv) {
      throw new Error('Chat is still loading. Please try again in a moment.');
    }

    // Usage limit check
    const plan = await getUserPlan();
    const used = await getMonthlyUsageCount();
    const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
    if (used >= limit) {
      throw new Error(`You've reached your monthly generation limit (${limit}) on the ${plan} plan. Upgrade to continue building.`);
    }

    onProgress?.('Prompt received');

    const userMessage: AIMessage = {
      id: crypto.randomUUID(),
      conversation_id: conv.id,
      role: 'user',
      content,
      tool_calls: null,
      changed_files: null,
      metadata: {},
      created_at: new Date().toISOString(),
    };
    set((state) => ({ messages: [...state.messages, userMessage] }));

    await supabase.from('ai_messages').insert({
      conversation_id: conv.id,
      role: 'user',
      content,
    });

    onProgress?.(`Sending request to AI with ${get().files.filter((file) => !file.is_directory).length} existing files`);

    const project = get().currentProject;
    if (!project) {
      throw new Error('Project is still loading. Please try again in a moment.');
    }

    const isFirstPrompt = get().messages.length === 1;
    const hasStarterOnly = get().files.length > 0 && get().files.length <= 6;
    const isInitialGen = isFirstPrompt || hasStarterOnly;
    
    if (!isInitialGen) {
      try {
        await get().createVersion(projectId, `Before: ${content.slice(0, 30)}`, 'Auto checkpoint before generation');
      } catch {
        // Continue if version creation fails
      }
    } else {
      onProgress?.('Initial generation from wizard Describe - full app synthesis');
    }

    // Build conversation history for context
    const conversationHistory = get().messages.map((m) => ({ role: m.role, content: m.content }));
    const stateManagement = project.state_management || 'provider';

    // ── CHAT MODE: general questions get conversational AI responses ──
    const hasFiles = get().files.filter((f) => !f.is_directory).length > 6;
    if (isChatMessage(content, hasFiles)) {
      onProgress?.('Processing your question...');

      // Create a placeholder assistant message that streams in real-time
      const streamingMsgId = crypto.randomUUID();
      const streamingMessage: AIMessage = {
        id: streamingMsgId,
        conversation_id: conv.id,
        role: 'assistant',
        content: '',
        tool_calls: null,
        changed_files: null,
        metadata: { isChat: true, streaming: true },
        created_at: new Date().toISOString(),
      };
      set((state) => ({ messages: [...state.messages, streamingMessage] }));

      let chatResponse = '';
      try {
        chatResponse = await chatWithAI(
          get().messages.slice(0, -1), // exclude the streaming placeholder
          get().files,
          onProgress,
          (token) => {
            // Update the streaming message in real-time
            set((state) => ({
              messages: state.messages.map((m) =>
                m.id === streamingMsgId ? { ...m, content: m.content + token } : m
              ),
            }));
          },
        );
      } catch (e) {
        chatResponse = `I ran into an issue reaching the AI service (${(e as Error).message?.slice(0, 80)}). Please try again.`;
      }

      // Finalize the message
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === streamingMsgId
            ? { ...m, content: chatResponse, metadata: { isChat: true } }
            : m
        ),
      }));

      await supabase.from('ai_messages').insert({
        conversation_id: conv.id,
        role: 'assistant',
        content: chatResponse,
        changed_files: null,
        metadata: { isChat: true },
      });

      await trackUsage(projectId, 'generation');
      onProgress?.('Response ready');
      return;
    }

    // ── PLAN MODE: Skip by default for Lovable-style instant generation ──
    // Only plan if user explicitly enabled it in settings
    if (isInitialGen && !get().pendingPlan) {
      const wantPlan = localStorage.getItem('ff_enable_planning') === 'true';
      if (wantPlan) {
        await get().requestPlan(projectId, content, onProgress);
        return;
      }
    }

    // ── CODE GENERATION MODE ──
    const changedFiles = await requestAIGeneration(
      get().messages,
      get().files,
      isInitialGen,
      project.name,
      stateManagement,
      conversationHistory,
      onProgress,
      get().lastApprovedPlan,
    );
    onProgress?.(`AI returned ${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'}`);

    // Track usage
    await trackUsage(projectId, 'generation');

    for (const change of changedFiles) {
      onProgress?.(`${change.action === 'created' ? 'Creating' : 'Updating'} ${change.path}`);
      if (change.action === 'created' || change.action === 'modified') {
        const existing = get().files.find((f) => f.path === change.path);
        if (existing) {
          await get().saveFile(projectId, change.path, change.content ?? '');
        } else {
          await get().createFile(projectId, change.path, change.content ?? '');
        }
      } else if (change.action === 'deleted') {
        await get().deleteFile(projectId, change.path);
      }
    }

    const nextActionPrompts = generateNextActionPrompts(content, changedFiles);
    const assistantContent = buildAssistantResponse(content, changedFiles);
    const assistantMessage: AIMessage = {
      id: crypto.randomUUID(),
      conversation_id: conv.id,
      role: 'assistant',
      content: assistantContent,
      tool_calls: null,
      changed_files: changedFiles,
      metadata: { fileCount: changedFiles.length, nextActionPrompts },
      created_at: new Date().toISOString(),
    };
    set((state) => ({ messages: [...state.messages, assistantMessage] }));

    await supabase.from('ai_messages').insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: assistantContent,
      changed_files: changedFiles,
      metadata: { nextActionPrompts },
    });

    await get().loadFiles(projectId);
    onProgress?.('Files saved and explorer refreshed');

    // Always rebuild preview after generation (Lovable-style)
    onProgress?.('Building live preview...');
    try {
      const previewStore = usePreviewStore.getState();
      // Stop any existing session first
      const existingSession = previewStore.getSession(projectId);
      if (existingSession && (existingSession.status === 'running' || existingSession.status === 'building')) {
        await previewStore.stop(existingSession.sessionId);
      }
      const currentFiles = get().files
        .filter((f) => !f.is_directory)
        .map((f) => ({ path: f.path, content: f.content }));
      if (currentFiles.length > 0) {
        await previewStore.build(projectId, currentFiles, {
          supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
          supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        });
        onProgress?.('Preview ready');
        // Auto-switch to preview tab
        const { setActiveView } = useWorkspaceStore.getState();
        setActiveView('preview');
      }
    } catch {
      // Auto-build is best-effort — don't block the flow
    }
  },

  requestPlan: async (projectId, content, onProgress) => {
    const conv = get().conversation;
    if (!conv) {
      throw new Error('Chat is still loading. Please try again in a moment.');
    }

    set({ planLoading: true, pendingPlan: null });
    onProgress?.('Analyzing your request...');

    // Add user message to chat
    const userMessage: AIMessage = {
      id: crypto.randomUUID(),
      conversation_id: conv.id,
      role: 'user',
      content,
      tool_calls: null,
      changed_files: null,
      metadata: {},
      created_at: new Date().toISOString(),
    };
    set((state) => ({ messages: [...state.messages, userMessage] }));

    await supabase.from('ai_messages').insert({
      conversation_id: conv.id,
      role: 'user',
      content,
    });

    try {
      let apiKey: string;
      try {
        apiKey = keyPool.getNextKey();
      } catch {
        apiKey = import.meta.env.VITE_OPENROUTER_API_KEY || '';
      }

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      const edgeUrl = `${supabaseUrl}/functions/v1/ai-generate`;

      const project = get().currentProject;
      const isInitialGen = get().files.length <= 6;
      const response = await fetch(edgeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${supabaseAnonKey}`,
          'apikey': supabaseAnonKey,
          'X-OpenRouter-Key': apiKey,
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content }],
          files: get().files.filter((f) => !f.is_directory).map((f) => ({ path: f.path, content: f.content })),
          mode: isInitialGen ? 'new' : 'edit',
          planMode: true,
        }),
      });

      if (response.ok && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let planJson = '';
        let hadError = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data) continue;

            try {
              const event = JSON.parse(data) as { type: string; message?: string; plan?: string; error?: string };
              if (event.type === 'status' && event.message) {
                onProgress?.(event.message);
              } else if (event.type === 'complete' && event.plan) {
                planJson = event.plan;
              } else if (event.type === 'error' && event.error) {
                hadError = true;
                onProgress?.(`Plan error: ${event.error.slice(0, 60)}`);
              }
            } catch {
              // skip malformed SSE
            }
          }
        }

        if (!hadError && planJson) {
          // Parse the plan JSON from the AI response
          let plan: AgentPlan;
          try {
            // Strip any markdown code fences if present
            const cleaned = planJson.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            plan = JSON.parse(cleaned) as AgentPlan;
          } catch {
            // If JSON parsing fails, create a minimal plan from the text
            plan = {
              summary: planJson.slice(0, 200),
              features: [],
              screens: [],
              tables: [],
              questions: [],
              estimatedFiles: 10,
              theme: { primaryColor: '#3B82F6', mode: 'light' },
            };
          }
          set({ pendingPlan: plan, planLoading: false });
          onProgress?.('Plan ready for review');
          return;
        }
      }

      // Fallback: if edge function fails, skip planning and go straight to generation
      onProgress?.('Plan generation unavailable — proceeding directly to code generation');
      set({ pendingPlan: null, planLoading: false });
      // Auto-approve by calling sendMessage directly
      await get().sendMessage(projectId, content, onProgress);
    } catch (e) {
      set({ planLoading: false, pendingPlan: null });
      onProgress?.(`Plan failed (${(e as Error).message?.slice(0, 40)}) — proceeding to generation`);
      await get().sendMessage(projectId, content, onProgress);
    }
  },

  approvePlan: async (projectId, onProgress) => {
    const plan = get().pendingPlan;
    if (!plan) return;

    // Build the enriched prompt from the plan + any question answers
    let enrichedPrompt = '';
    const lastUserMsg = [...get().messages].reverse().find((m) => m.role === 'user');
    if (lastUserMsg) {
      enrichedPrompt = lastUserMsg.content;
      if (plan.answers && Object.keys(plan.answers).length > 0) {
        const answerText = Object.entries(plan.answers)
          .map(([idx, ans]) => `Q${Number(idx) + 1}: ${ans}`)
          .join('\n');
        enrichedPrompt += `\n\nAdditional context from user:\n${answerText}`;
      }
      // Add plan details to give the generation more context
      enrichedPrompt += `\n\nPlanned features: ${plan.features.join(', ')}`;
      enrichedPrompt += `\nPlanned screens: ${plan.screens.map((s) => s.name).join(', ')}`;
      if (plan.tables.length > 0) {
        enrichedPrompt += `\nPlanned tables: ${plan.tables.map((t) => t.name).join(', ')}`;
      }
    }

    set({ pendingPlan: null, lastApprovedPlan: plan });
    const conv = get().conversation;
    if (conv) {
      const approvalMsg: AIMessage = {
        id: crypto.randomUUID(),
        conversation_id: conv.id,
        role: 'assistant',
        content: `Plan approved. Generating ${plan.estimatedFiles} files with ${plan.screens.length} screens...`,
        tool_calls: null,
        changed_files: null,
        metadata: { isPlanApproval: true },
        created_at: new Date().toISOString(),
      };
      set((state) => ({ messages: [...state.messages, approvalMsg] }));
    }

    // Now run the actual generation
    await get().sendMessage(projectId, enrichedPrompt, onProgress);
    set({ lastApprovedPlan: null });
  },

  rejectPlan: () => {
    set({ pendingPlan: null, planLoading: false });
  },

  answerQuestions: (answers) => {
    const plan = get().pendingPlan;
    if (!plan) return;
    set({ pendingPlan: { ...plan, answers } });
  },

  loadDependencies: async (projectId) => {
    const { data } = await supabase
      .from('dependencies')
      .select('*')
      .eq('project_id', projectId)
      .order('package_name', { ascending: true });
    set({ dependencies: (data as Dependency[]) ?? [] });
  },

  addDependency: async (projectId, packageName, version) => {
    const { data, error } = await supabase
      .from('dependencies')
      .insert({
        project_id: projectId,
        package_name: packageName,
        version,
        package_type: 'direct',
        status: 'installing',
      })
      .select('*')
      .single();
    if (!error && data) {
      set((state) => ({ dependencies: [...state.dependencies, data as Dependency] }));
      await supabase
        .from('dependencies')
        .update({ status: 'installed' })
        .eq('id', data.id);
      set((state) => ({
        dependencies: state.dependencies.map((d) =>
          d.id === data.id ? { ...d, status: 'installed' } : d
        ),
      }));
    }
  },

  removeDependency: async (projectId, packageId) => {
    await supabase.from('dependencies').delete().eq('id', packageId);
    set((state) => ({
      dependencies: state.dependencies.filter((d) => d.id !== packageId),
    }));
  },

  loadVersions: async (projectId) => {
    const { data } = await supabase
      .from('project_versions')
      .select('*')
      .eq('project_id', projectId)
      .order('version_number', { ascending: false });
    set({ versions: (data as ProjectVersion[]) ?? [] });
  },

  createVersion: async (projectId, label, description) => {
    const files = get().files;
    const snapshot: Record<string, { content: string }> = {};
    for (const f of files) {
      if (!f.is_directory) snapshot[f.path] = { content: f.content };
    }
    const versionNumber = get().versions.length + 1;
    const { data } = await supabase
      .from('project_versions')
      .insert({
        project_id: projectId,
        version_number: versionNumber,
        label,
        description,
        file_snapshot: snapshot,
      })
      .select('*')
      .single();
    if (data) {
      set((state) => ({ versions: [data as ProjectVersion, ...state.versions] }));
    }
  },

  restoreVersion: async (projectId, versionId) => {
    const version = get().versions.find((v) => v.id === versionId);
    if (!version) return;
    const snapshot = version.file_snapshot;
    const currentFiles = get().files;

    for (const [path, data] of Object.entries(snapshot)) {
      const existing = currentFiles.find((f) => f.path === path);
      if (existing) {
        await get().saveFile(projectId, path, data.content);
      } else {
        await get().createFile(projectId, path, data.content);
      }
    }

    for (const file of currentFiles) {
      if (!file.is_directory && !(file.path in snapshot)) {
        await get().deleteFile(projectId, file.path);
      }
    }

    await get().loadFiles(projectId);
  },

  restoreFile: async (projectId, filePath, content) => {
    if (content !== undefined) {
      await get().saveFile(projectId, filePath, content);
      await get().loadFiles(projectId);
      return;
    }

    // Lookup in previous versions
    const prevVersions = get().versions;
    for (const v of prevVersions) {
      const snap = v.file_snapshot?.[filePath];
      if (snap?.content !== undefined) {
        await get().saveFile(projectId, filePath, snap.content);
        await get().loadFiles(projectId);
        return;
      }
    }
  },

  loadBuilds: async (projectId) => {
    const { data } = await supabase
      .from('builds')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    set({ builds: (data as Build[]) ?? [] });
  },

  loadDeployments: async (projectId) => {
    const { data } = await supabase
      .from('deployments')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    set({ deployments: (data as Deployment[]) ?? [] });
  },

  clearCurrent: () => {
    set({
      currentProject: null,
      files: [],
      versions: [],
      conversation: null,
      messages: [],
      tasks: [],
      builds: [],
      dependencies: [],
      deployments: [],
      pendingPlan: null,
      planLoading: false,
      lastApprovedPlan: null,
    });
  },

  clearError: () => set({ error: null }),
}));

function buildAssistantResponse(prompt: string, changes: FileChange[]): string {
  const created = changes.filter((c) => c.action === 'created');
  const modified = changes.filter((c) => c.action === 'modified');
  const deleted = changes.filter((c) => c.action === 'deleted');

  let response = `I've analyzed your request and generated the Flutter project files.\n\n`;
  response += `**Summary:**\n`;
  if (created.length > 0) response += `- Created ${created.length} file(s)\n`;
  if (modified.length > 0) response += `- Modified ${modified.length} file(s)\n`;
  if (deleted.length > 0) response += `- Deleted ${deleted.length} file(s)\n`;
  response += `\n**Files changed:**\n`;
  for (const c of changes) {
    const icon = c.action === 'created' ? 'A' : c.action === 'modified' ? 'M' : 'D';
    response += `${icon} ${c.path}\n`;
  }
  response += `\nReview the changes in the file explorer, then run the analyzer and build to preview your app.`;
  return response;
}

export function generateNextActionPrompts(prompt: string, changes: FileChange[]): string[] {
  const lower = prompt.toLowerCase();
  const prompts: string[] = [];

  const hasSql = changes.some((c) => c.path.endsWith('.sql'));
  const hasAuth = changes.some((c) => c.path.includes('auth'));
  const hasCart = changes.some((c) => c.path.includes('cart'));

  if (!lower.includes('dark') && !lower.includes('theme')) {
    prompts.push('Add an animated Dark/Light Mode toggle');
  }

  if (!hasAuth && !lower.includes('auth') && !lower.includes('login')) {
    prompts.push('Add Supabase Auth with login, signup and password recovery');
  }

  if (lower.includes('ecommerce') || lower.includes('shop') || hasCart) {
    prompts.push('Add Stripe checkout flow and order receipt history');
    prompts.push('Add category filter and price range slider');
  } else if (lower.includes('crypto') || lower.includes('wallet')) {
    prompts.push('Add interactive price history chart with 24h P&L');
    prompts.push('Add real-time price alerts in Supabase');
  } else if (lower.includes('chat') || lower.includes('ai')) {
    prompts.push('Add streaming typewriter response effect');
    prompts.push('Add voice input and audio message recorder');
  } else {
    prompts.push('Add a search bar with instant autocomplete');
    prompts.push('Add real-time Supabase subscription stream');
  }

  if (hasSql) {
    prompts.push('Generate mock seed data SQL for instant testing');
  }

  return prompts.slice(0, 4);
}


async function requestAIGeneration(
  messages: AIMessage[],
  files: ProjectFile[],
  isInitialGeneration: boolean,
  projectName = 'FlutterForgeApp',
  stateManagement = 'provider',
  conversationHistory: Array<{ role: string; content: string }> = [],
  onProgress?: (msg: string) => void,
  planData?: AgentPlan | null,
): Promise<FileChange[]> {
  // TIER 1: Edge Function with SSE streaming (real AI generation with model fallback chain)
  try {
    onProgress?.('Connecting to AI generation service...');
    let edgeKey: string;
    try {
      edgeKey = keyPool.getNextKey();
    } catch {
      // Key pool empty — try singular env var directly
      edgeKey = import.meta.env.VITE_OPENROUTER_API_KEY || '';
      if (!edgeKey) {
        throw new Error('No OpenRouter API keys configured. Add VITE_OPENROUTER_API_KEYS to your .env file.');
      }
    }
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
    const edgeUrl = `${supabaseUrl}/functions/v1/ai-generate`;

    // Use parallel generation when we have plan data with screens
    const useParallel = planData && planData.screens && planData.screens.length > 2;

    const response = await fetch(edgeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${supabaseAnonKey}`,
        'apikey': supabaseAnonKey,
        'X-OpenRouter-Key': edgeKey,
      },
      body: JSON.stringify({
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        files: files.filter((file) => !file.is_directory).map((file) => ({
          path: file.path,
          content: file.content,
        })),
        mode: isInitialGeneration ? 'new' : 'edit',
        ...(useParallel ? { parallel: true, planData } : {}),
      }),
    });

    if (response.ok && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let generatedFiles: Array<{ path: string; content: string }> = [];
      let usedModel = '';
      let hadError = false;
      let batchCount = 0;

      const timeoutMs = useParallel ? 180000 : 120000;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Edge SSE timeout ${timeoutMs / 1000}s`)), timeoutMs)
      );

      const readPromise = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data) continue;

            try {
              const event = JSON.parse(data) as { type: string; message?: string; content?: string; files?: Array<{ path: string; content: string }>; model?: string; error?: string; batch?: string; fileCount?: number };

              if (event.type === 'status' && event.message) {
                onProgress?.(event.message);
              } else if (event.type === 'token' && event.content) {
                // Token streaming — not displayed in parallel mode
              } else if (event.type === 'batch_complete') {
                batchCount++;
                onProgress?.(`Batch "${event.batch}" completed: ${event.fileCount} files`);
                if (event.files) {
                  // Merge batch files — dedupe by path
                  const existingPaths = new Set(generatedFiles.map((f) => f.path));
                  for (const f of event.files) {
                    if (existingPaths.has(f.path)) {
                      generatedFiles = generatedFiles.map((existing) =>
                        existing.path === f.path ? f : existing
                      );
                    } else {
                      generatedFiles.push(f);
                    }
                  }
                }
              } else if (event.type === 'warning' && event.message) {
                onProgress?.(event.message);
              } else if (event.type === 'complete') {
                if (event.files && Array.isArray(event.files) && event.files.length > 0) {
                  generatedFiles = event.files;
                }
                if (event.model) usedModel = event.model;
                onProgress?.(`AI generated ${generatedFiles.length} files using ${usedModel || (batchCount > 0 ? `${batchCount} parallel batches` : 'model')}`);
              } else if (event.type === 'error' && event.error) {
                hadError = true;
                onProgress?.(`Edge error: ${event.error.slice(0, 60)}`);
              }
            } catch {
              // skip malformed SSE lines
            }
          }
        }
      })();

      await Promise.race([readPromise, timeoutPromise]).catch((e) => {
        hadError = true;
        onProgress?.(`Edge stream error (${(e as Error).message?.slice(0, 40)})`);
      });

      if (!hadError && generatedFiles.length > 0) {
        const existingPaths = new Set(files.map((file) => file.path));
        return generatedFiles
          .filter((file) => typeof file.path === 'string' && typeof file.content === 'string')
          .map((file) => ({
            path: file.path,
            content: file.content,
            action: existingPaths.has(file.path) ? ('modified' as const) : ('created' as const),
          }));
      }

      if (!hadError) {
        onProgress?.('Edge returned no files - trying local AI agent...');
      }
    } else {
      onProgress?.(`Edge HTTP ${response.status} - trying local AI agent...`);
    }
  } catch (e) {
    onProgress?.(`Edge connection error (${(e as Error).message?.slice(0, 40)}) - trying local AI agent...`);
  }

  // TIER 2: Local FlutterSupabaseAgent (client-side AI with model fallback chain)
  onProgress?.('Generating with local AI agent (Nemotron Ultra + fallback models)...');
  const latestUserPrompt = messages.filter((m) => m.role === 'user').pop()?.content || 'Create Flutter application';
  const context = AgentContextBuilder.buildContext({
    projectId: 'active-project',
    projectName,
    files,
    conversationHistory: messages.map((m) => ({ role: m.role, content: m.content })),
    supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
    supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  });

  // Detect if this is an incremental edit (follow-up prompt after initial generation)
  const isIncremental = !isInitialGeneration && files.length > 6;

  let localApiKey: string;
  try {
    localApiKey = keyPool.getNextKey();
  } catch {
    localApiKey = import.meta.env.VITE_OPENROUTER_API_KEY || '';
  }

  const result = await FlutterSupabaseAgent.execute(latestUserPrompt, context, {
    enableAutoHealing: true,
    stateManagement: stateManagement as 'provider' | 'riverpod' | 'bloc' | 'change_notifier',
    isIncremental,
    conversationHistory,
    modelConfig: {
      provider: 'custom',
      modelName: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      apiKey: localApiKey,
    },
    onEvent: (event) => {
      onProgress?.(event.message);
    },
  });

  const existingFileMap = new Map(files.map((file) => [file.path, file.content]));
  return result.files.map((file) => ({
    path: file.path,
    content: file.content,
    oldContent: existingFileMap.get(file.path),
    action: existingFileMap.has(file.path) ? ('modified' as const) : ('created' as const),
  }));
}

