import { AlertTriangle, AlertCircle, Info, XCircle, ChevronRight, Wrench, RefreshCw, Loader2 } from 'lucide-react';
import { useState, useCallback } from 'react';
import { useTerminalStore } from '@/stores/terminal.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { useProjectStore } from '@/stores/project.store';
import { cn } from '@/utils/cn';
import { toast } from '@/components/ui/Toast';

const PREVIEW_SERVER_URL = import.meta.env.VITE_PREVIEW_SERVER_URL || 'http://localhost:3001';

interface AnalyzerDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: string;
  message: string;
  errorCode: string;
}

export function ProblemsPanel() {
  const { problems, clearProblems, addProblem } = useTerminalStore();
  const { openFile } = useWorkspaceStore();
  const { files, currentProject } = useProjectStore();
  const [analyzing, setAnalyzing] = useState(false);

  const runAnalyzer = useCallback(async () => {
    if (!currentProject || files.length === 0) {
      toast('error', 'No project files to analyze.');
      return;
    }

    setAnalyzing(true);
    clearProblems();

    try {
      const projectFiles = files
        .filter((f) => !f.is_directory)
        .map((f) => ({ path: f.path, content: f.content }));

      const response = await fetch(`${PREVIEW_SERVER_URL}/api/analyze/${currentProject.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: projectFiles }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Analyzer request failed' }));
        toast('error', `Analyzer failed: ${err.error || response.statusText}`);
        return;
      }

      const data = await response.json() as { diagnostics: AnalyzerDiagnostic[]; count: number };

      for (const diag of data.diagnostics) {
        addProblem({
          file: diag.file,
          line: diag.line,
          column: diag.column,
          message: diag.message,
          severity: (diag.severity === 'error' ? 'error' : diag.severity === 'warning' ? 'warning' : 'info') as 'error' | 'warning' | 'info',
        });
      }

      if (data.count === 0) {
        toast('success', 'No problems detected. Clean build!');
      } else {
        toast('info', `Found ${data.count} issue${data.count === 1 ? '' : 's'}.`);
      }
    } catch (e) {
      toast('error', `Analyzer error: ${(e as Error).message}`);
    } finally {
      setAnalyzing(false);
    }
  }, [currentProject, files, clearProblems, addProblem]);

  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');
  const infos = problems.filter((p) => p.severity === 'info');

  return (
    <div className="flex flex-col h-full bg-[var(--ff-bg)]">
      <div className="flex items-center gap-4 px-3 py-2 border-b border-[var(--ff-border)] shrink-0">
        <span className="flex items-center gap-1.5 text-xs">
          <XCircle size={14} className="text-red-400" />
          <span className="text-[var(--ff-text-muted)]">{errors.length} Errors</span>
        </span>
        <span className="flex items-center gap-1.5 text-xs">
          <AlertTriangle size={14} className="text-amber-400" />
          <span className="text-[var(--ff-text-muted)]">{warnings.length} Warnings</span>
        </span>
        <span className="flex items-center gap-1.5 text-xs">
          <Info size={14} className="text-blue-400" />
          <span className="text-[var(--ff-text-muted)]">{infos.length} Info</span>
        </span>
        <button
          onClick={runAnalyzer}
          disabled={analyzing}
          className="ml-auto flex items-center gap-1.5 px-2 py-1 rounded text-xs text-[var(--ff-text-muted)] hover:text-[var(--ff-primary)] hover:bg-[var(--ff-surface-2)] transition-colors disabled:opacity-50"
        >
          {analyzing ? <Loader2 size={12} className="ff-spin" /> : <RefreshCw size={12} />}
          {analyzing ? 'Analyzing...' : 'Run Analyzer'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto ff-scrollbar px-2 py-1">
        {problems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-8">
            <div className="w-10 h-10 rounded-full bg-emerald-500/10 flex items-center justify-center mb-2">
              <span className="text-emerald-400 text-lg">✓</span>
            </div>
            <p className="text-xs text-[var(--ff-text-muted)]">No problems detected</p>
            <p className="text-[10px] text-[var(--ff-text-dim)] mt-1">Click "Run Analyzer" to check for issues</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {problems.map((problem) => {
              const Icon = problem.severity === 'error' ? XCircle : problem.severity === 'warning' ? AlertTriangle : Info;
              const color = problem.severity === 'error' ? 'text-red-400' : problem.severity === 'warning' ? 'text-amber-400' : 'text-blue-400';
              return (
                <div
                  key={problem.id}
                  onClick={() => openFile(problem.file)}
                  className="flex items-start gap-2 px-2 py-1.5 rounded hover:bg-[var(--ff-surface-2)] cursor-pointer group"
                >
                  <Icon size={14} className={cn(color, 'mt-0.5 shrink-0')} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-[var(--ff-text-muted)] truncate">{problem.message}</p>
                    <p className="text-[10px] text-[var(--ff-text-dim)] font-mono">{problem.file}:{problem.line}:{problem.column}</p>
                  </div>
                  <button className="opacity-0 group-hover:opacity-100 p-1 rounded text-[var(--ff-text-dim)] hover:text-[var(--ff-primary)] transition-all">
                    <Wrench size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
