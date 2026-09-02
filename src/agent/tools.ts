import type { AgentContext, AgentFileArtifact } from './types';

export interface AgentTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
  success: boolean;
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'read_file',
    description: 'Read the full content of a workspace file by path',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file path to read, e.g. lib/main.dart' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or fully overwrite a file in the workspace',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file path to write' },
        content: { type: 'string', description: 'The complete file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'apply_patch',
    description: 'Surgically replace a code block in an existing file using SEARCH/REPLACE blocks',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file path to patch' },
        search: { type: 'string', description: 'The exact text to find (SEARCH block)' },
        replace: { type: 'string', description: 'The replacement text (REPLACE block)' },
      },
      required: ['path', 'search', 'replace'],
    },
  },
  {
    name: 'list_files',
    description: 'List all files in the workspace',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'run_analyzer',
    description: 'Run static analysis on the project and return diagnostics',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'execute_sql',
    description: 'Execute a SQL migration on the connected Supabase project',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'The SQL to execute' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'task_complete',
    description: 'Signal that the task is fully done and provide a summary',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Summary of what was accomplished' },
      },
      required: ['summary'],
    },
  },
];

export function getToolSchemas(): unknown[] {
  return AGENT_TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function executeTool(
  call: ToolCall,
  context: AgentContext,
  workspace: Map<string, string>,
  diagnostics: string[]
): ToolResult {
  switch (call.name) {
    case 'read_file': {
      const path = call.args.path as string;
      const content = workspace.get(path);
      if (content === undefined) {
        return { tool_call_id: call.id, success: false, content: `File not found: ${path}` };
      }
      return { tool_call_id: call.id, success: true, content };
    }

    case 'write_file': {
      const path = call.args.path as string;
      const content = call.args.content as string;
      workspace.set(path, content);
      return { tool_call_id: call.id, success: true, content: `Wrote ${content.length} chars to ${path}` };
    }

    case 'apply_patch': {
      const path = call.args.path as string;
      const search = call.args.search as string;
      const replace = call.args.replace as string;
      const current = workspace.get(path);
      if (current === undefined) {
        return { tool_call_id: call.id, success: false, content: `File not found: ${path}` };
      }
      const idx = current.indexOf(search);
      if (idx === -1) {
        const fuzzyIdx = fuzzyFind(current, search);
        if (fuzzyIdx === -1) {
          return { tool_call_id: call.id, success: false, content: `SEARCH block not found in ${path}` };
        }
        const patched = current.slice(0, fuzzyIdx) + replace + current.slice(fuzzyIdx + search.length);
        workspace.set(path, patched);
        return { tool_call_id: call.id, success: true, content: `Patched ${path} (fuzzy match)` };
      }
      const patched = current.slice(0, idx) + replace + current.slice(idx + search.length);
      workspace.set(path, patched);
      return { tool_call_id: call.id, success: true, content: `Patched ${path}` };
    }

    case 'list_files': {
      const paths = Array.from(workspace.keys()).sort();
      return { tool_call_id: call.id, success: true, content: paths.join('\n') };
    }

    case 'run_analyzer': {
      return {
        tool_call_id: call.id,
        success: true,
        content: diagnostics.length > 0 ? diagnostics.join('\n') : 'No issues found.',
      };
    }

    case 'execute_sql': {
      const sql = call.args.sql as string;
      return {
        tool_call_id: call.id,
        success: true,
        content: `SQL migration queued (${sql.length} chars). Would execute on Supabase project.`,
      };
    }

    case 'task_complete': {
      return { tool_call_id: call.id, success: true, content: call.args.summary as string };
    }

    default:
      return { tool_call_id: call.id, success: false, content: `Unknown tool: ${call.name}` };
  }
}

function fuzzyFind(text: string, search: string): number {
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  const normalizedSearch = search.replace(/\s+/g, ' ').trim();
  return normalizedText.indexOf(normalizedSearch);
}

export function workspaceToArtifacts(workspace: Map<string, string>, existingPaths: Set<string>): AgentFileArtifact[] {
  const artifacts: AgentFileArtifact[] = [];
  for (const [path, content] of workspace) {
    const isNew = !existingPaths.has(path);
    artifacts.push({
      path,
      content,
      isNew,
      action: isNew ? 'created' : 'modified',
      language: detectLanguage(path),
    });
  }
  return artifacts;
}

function detectLanguage(path: string): AgentFileArtifact['language'] {
  if (path.endsWith('.dart')) return 'dart';
  if (path.endsWith('.yaml')) return 'yaml';
  if (path.endsWith('.sql')) return 'sql';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.md')) return 'markdown';
  if (path.endsWith('.env')) return 'env';
  return 'dart';
}
