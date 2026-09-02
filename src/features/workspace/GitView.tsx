import { GitBranch, GitCommit, Plus, RotateCcw, History, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { useProjectStore } from '@/stores/project.store';
import { useTerminalStore } from '@/stores/terminal.store';

export function GitView() {
  const { currentProject, versions, restoreVersion } = useProjectStore();
  const { addLine } = useTerminalStore();
  const [restoring, setRestoring] = useState<string | null>(null);

  if (!currentProject) return null;

  async function handleRestore(versionId: string, label: string) {
    setRestoring(versionId);
    addLine({ type: 'command', content: `$ git checkout ${label}` });
    try {
      await restoreVersion(currentProject!.id, versionId);
      addLine({ type: 'success', content: `Restored to: ${label}` });
      toast('success', `Restored project to: ${label}`);
    } catch {
      addLine({ type: 'error', content: 'Restore failed' });
      toast('error', 'Failed to restore version.');
    } finally {
      setRestoring(null);
    }
  }

  return (
    <div className="flex flex-col h-full bg-[var(--ff-bg)] overflow-y-auto ff-scrollbar">
      <div className="max-w-3xl mx-auto w-full p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitBranch size={18} className="text-[var(--ff-primary)]" />
            <h2 className="text-lg font-semibold text-white">Version History</h2>
          </div>
          <Button
            size="sm"
            icon={<Plus size={14} />}
            onClick={() => toast('info', 'Use the AI chat to generate new versions. Each prompt auto-creates a checkpoint.')}
          >
            New Checkpoint
          </Button>
        </div>

        {/* Branch info */}
        <div className="ff-card p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[var(--ff-primary)]/10 flex items-center justify-center">
              <GitBranch size={18} className="text-[var(--ff-primary)]" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">main</p>
              <p className="text-xs text-[var(--ff-text-dim)]">{versions.length} checkpoint{versions.length === 1 ? '' : 's'}</p>
            </div>
          </div>
          <Badge variant="success">Current</Badge>
        </div>

        {/* Version history */}
        <div>
          <h3 className="text-xs font-semibold text-[var(--ff-text-dim)] uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <History size={12} />
            Checkpoint History
          </h3>
          {versions.length === 0 ? (
            <div className="ff-card p-6 text-center">
              <p className="text-sm text-[var(--ff-text-muted)]">No checkpoints yet</p>
              <p className="text-xs text-[var(--ff-text-dim)] mt-1">
                When you send a prompt to the AI, a version snapshot is automatically created before changes are applied.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {versions.map((version, idx) => (
                <div key={version.id} className="ff-card p-3 flex items-center gap-3 group hover:border-[var(--ff-border-hover)] transition-all">
                  <div className="w-8 h-8 rounded-lg bg-[var(--ff-surface-2)] flex items-center justify-center shrink-0">
                    {idx === 0 ? (
                      <GitCommit size={14} className="text-[var(--ff-primary)]" />
                    ) : (
                      <GitCommit size={14} className="text-[var(--ff-text-muted)]" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">
                      {version.label || `Version ${version.version_number}`}
                    </p>
                    <p className="text-[10px] text-[var(--ff-text-dim)] font-mono">
                      v{version.version_number} · {new Date(version.created_at).toLocaleString()} · {Object.keys(version.file_snapshot || {}).length} files
                    </p>
                    {version.description && (
                      <p className="text-[10px] text-[var(--ff-text-dim)] mt-0.5 truncate">{version.description}</p>
                    )}
                  </div>
                  {idx > 0 && (
                    <button
                      onClick={() => handleRestore(version.id, version.label || `v${version.version_number}`)}
                      disabled={restoring === version.id}
                      className="opacity-0 group-hover:opacity-100 p-1.5 rounded text-[var(--ff-text-dim)] hover:text-[var(--ff-primary)] transition-all disabled:opacity-50"
                      title="Restore this version"
                    >
                      {restoring === version.id ? <Loader2 size={14} className="ff-spin" /> : <RotateCcw size={14} />}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Info banner */}
        <div className="ff-card p-4 bg-blue-500/5 border-blue-500/20">
          <p className="text-xs text-[var(--ff-text-muted)] leading-relaxed">
            Each AI prompt automatically creates a version checkpoint before applying changes. Use the restore button to roll back to any previous state. Full Git integration with GitHub is coming soon.
          </p>
        </div>
      </div>
    </div>
  );
}
