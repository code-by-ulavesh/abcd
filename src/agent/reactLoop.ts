import type {
  AgentContext,
  AgentGenerationOptions,
  AgentGenerationResult,
  AgentEvent,
  AgentFileArtifact,
  AgentPlan,
  ValidationReport,
} from './types';
import { OpenRouterClient } from './llmClient';
import { AgentPlanner } from './planner';
import { AgentValidator } from './validator';
import { VectorStore } from './vectorStore';
import { AgentContextBuilder } from './context';
import {
  AGENT_TOOLS,
  getToolSchemas,
  executeTool,
  workspaceToArtifacts,
  type ToolCall,
} from './tools';
import { FLUTTER_SUPABASE_SYSTEM_PROMPT } from './prompts';

const MAX_ITERATIONS = 12;

const REACT_SYSTEM_PROMPT = `${FLUTTER_SUPABASE_SYSTEM_PROMPT}

You are operating in an autonomous ReAct (Reason-Act-Observe) loop with tool-calling capabilities.
You have access to tools that let you read, write, and patch files, run the analyzer, and execute SQL.

WORKFLOW:
1. Read existing files to understand the current state
2. Write or patch files to implement the requested feature
3. Run the analyzer to check for errors
4. If errors exist, fix them by patching the problematic files
5. Call task_complete when done

RULES:
- Use apply_patch for surgical edits to existing files (much cheaper than rewriting)
- Use write_file only for new files or complete rewrites
- Always read a file before patching it
- Run the analyzer after making changes
- Iterate until the analyzer reports 0 errors, then call task_complete
- Do NOT generate more than 25 files in a single session`;

export class ReactAgentLoop {
  private llmClient: OpenRouterClient;
  private workspace = new Map<string, string>();
  private existingPaths = new Set<string>();
  private diagnostics: string[] = [];

  constructor(llmClient: OpenRouterClient) {
    this.llmClient = llmClient;
  }

  async run(
    prompt: string,
    context: AgentContext,
    options: AgentGenerationOptions = {}
  ): Promise<AgentGenerationResult> {
    const startTime = performance.now();
    const logs: string[] = [];

    const emit = (event: Omit<AgentEvent, 'timestamp'>) => {
      const fullEvent: AgentEvent = { ...event, timestamp: new Date().toISOString() };
      logs.push(`[${fullEvent.phase.toUpperCase()}] ${fullEvent.message}`);
      options.onEvent?.(fullEvent);
    };

    // Initialize workspace from existing files
    for (const file of context.existingFiles) {
      if (!file.isDirectory && !file.is_directory) {
        this.workspace.set(file.path, file.content);
        this.existingPaths.add(file.path);
      }
    }

    emit({
      phase: 'analyzing',
      stepNumber: 1,
      totalSteps: MAX_ITERATIONS,
      message: `ReAct loop starting. Workspace has ${this.workspace.size} files.`,
    });

    // Build initial messages
    const messages: Array<{ role: string; content: string; tool_calls?: unknown; tool_call_id?: string }> = [
      { role: 'system', content: REACT_SYSTEM_PROMPT },
      { role: 'user', content: this.buildUserPrompt(prompt, context) },
    ];

    // Add conversation history
    const history = options.conversationHistory || [];
    for (const msg of history.slice(-8)) {
      messages.push({ role: msg.role, content: msg.content });
    }

    let iteration = 0;
    let taskComplete = false;
    let completionSummary = '';

    for (; iteration < MAX_ITERATIONS; iteration++) {
      emit({
        phase: 'code_generation',
        stepNumber: iteration + 1,
        totalSteps: MAX_ITERATIONS,
        message: `ReAct iteration ${iteration + 1}/${MAX_ITERATIONS}: deciding next action...`,
      });

      let toolCalls: ToolCall[] = [];
      let assistantContent = '';

      try {
        const result = await this.llmClient.chatWithTools(
          messages,
          getToolSchemas(),
          { temperature: 0.2, maxTokens: 32000 }
        );
        toolCalls = result.toolCalls;
        assistantContent = result.content;

        messages.push({ role: 'assistant', content: assistantContent, tool_calls: result.rawToolCalls });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({
          phase: 'failed',
          stepNumber: iteration + 1,
          totalSteps: MAX_ITERATIONS,
          message: `LLM call failed: ${msg}`,
        });
        break;
      }

      if (toolCalls.length === 0) {
        // No tool calls — check if the model said it's done
        if (assistantContent.toLowerCase().includes('done') || assistantContent.toLowerCase().includes('complete')) {
          taskComplete = true;
          completionSummary = assistantContent;
          break;
        }
        // Push a reminder to use tools
        messages.push({
          role: 'user',
          content: 'Please use the available tools to implement the changes. Call task_complete when done.',
        });
        continue;
      }

      // Execute each tool call
      for (const call of toolCalls) {
        if (call.name === 'task_complete') {
          taskComplete = true;
          completionSummary = (call.args.summary as string) || 'Task completed';
          emit({
            phase: 'completed',
            stepNumber: iteration + 1,
            totalSteps: MAX_ITERATIONS,
            message: `Task complete: ${completionSummary}`,
          });
          break;
        }

        emit({
          phase: 'code_generation',
          stepNumber: iteration + 1,
          totalSteps: MAX_ITERATIONS,
          message: `Tool: ${call.name}(${this.summarizeArgs(call)})`,
          activeFile: call.args.path as string | undefined,
        });

        const result = executeTool(call, context, this.workspace, this.diagnostics);

        messages.push({
          role: 'tool',
          content: result.content,
          tool_call_id: call.id,
        });

        if (call.name === 'run_analyzer') {
          this.diagnostics = result.content.split('\n').filter((l) => l.trim() && !l.includes('No issues'));
          if (this.diagnostics.length === 0) {
            emit({
              phase: 'validation',
              stepNumber: iteration + 1,
              totalSteps: MAX_ITERATIONS,
              message: 'Analyzer: 0 errors. Clean build.',
            });
          } else {
            emit({
              phase: 'validation',
              stepNumber: iteration + 1,
              totalSteps: MAX_ITERATIONS,
              message: `Analyzer: ${this.diagnostics.length} issues found. Feeding back to agent...`,
            });
          }
        }

        if (!result.success) {
          emit({
            phase: 'auto_healing',
            stepNumber: iteration + 1,
            totalSteps: MAX_ITERATIONS,
            message: `Tool ${call.name} failed: ${result.content.slice(0, 80)}`,
          });
        }
      }

      if (taskComplete) break;
    }

    if (!taskComplete) {
      completionSummary = `Completed after ${iteration} iterations (max reached)`;
      emit({
        phase: 'completed',
        stepNumber: MAX_ITERATIONS,
        totalSteps: MAX_ITERATIONS,
        message: completionSummary,
      });
    }

    // Convert workspace to file artifacts
    const generatedFiles = workspaceToArtifacts(this.workspace, this.existingPaths);

    // Run final validation
    const validationReport = AgentValidator.validate(generatedFiles);

    // Build a minimal plan for the result
    const plan: AgentPlan = {
      id: crypto.randomUUID(),
      appName: context.projectName || 'App',
      appDescription: prompt.slice(0, 200),
      architecture: 'feature_first',
      stateManagement: (options.stateManagement || 'provider') as AgentPlan['stateManagement'],
      domain: AgentPlanner.detectDomain(prompt.toLowerCase()),
      theme: { primaryColor: '#3B82F6', secondaryColor: '#8B5CF6', backgroundColor: '#FFFFFF', isDarkPreferred: false },
      dependencies: {},
      devDependencies: {},
      schema: { projectName: '', tables: [] },
      models: [],
      services: [],
      screens: [],
      filesToCreate: generatedFiles.map((f) => f.path),
      filesToModify: [],
      estimatedSteps: iteration,
    };

    // Async embedding
    if (context.projectId) {
      void VectorStore.embedProjectFiles(context.projectId, generatedFiles);
    }

    const durationMs = Math.round(performance.now() - startTime);

    return {
      success: true,
      plan,
      files: generatedFiles,
      schemaSql: generatedFiles.find((f) => f.path.endsWith('.sql'))?.content,
      validationReport,
      summary: completionSummary,
      durationMs,
      logs,
    };
  }

  private buildUserPrompt(prompt: string, context: AgentContext): string {
    const fileList = Array.from(this.workspace.keys()).sort();
    return `Project: ${context.projectName}
Request: ${prompt}

Current workspace files (${fileList.length}):
${fileList.map((p) => `- ${p}`).join('\n')}

Use the available tools to implement the request. Start by reading relevant files, then write or patch them. Run the analyzer when done, fix any errors, then call task_complete.`;
  }

  private summarizeArgs(call: ToolCall): string {
    if (call.args.path) return String(call.args.path);
    if (call.args.sql) return `(SQL: ${String(call.args.sql).slice(0, 40)}...)`;
    if (call.args.summary) return String(call.args.summary).slice(0, 60);
    return '';
  }
}
