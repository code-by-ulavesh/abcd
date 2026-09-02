import { useState } from 'react';
import {
  Check,
  X,
  FileCode2,
  Database,
  Layers,
  HelpCircle,
  Sparkles,
  ClipboardList,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import type { AgentPlan } from '@/types';
import { cn } from '@/utils/cn';

interface Props {
  plan: AgentPlan;
  onApprove: () => void;
  onReject: () => void;
  onAnswer: (answers: Record<number, string>) => void;
}

export function PlanApprovalCard({ plan, onApprove, onReject, onAnswer }: Props) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [showDetails, setShowDetails] = useState(true);
  const hasQuestions = plan.questions.length > 0;

  function handleAnswerChange(idx: number, value: string) {
    const next = { ...answers, [idx]: value };
    setAnswers(next);
    onAnswer(next);
  }

  return (
    <div className="rounded-2xl border border-[var(--ff-primary)]/30 bg-gradient-to-b from-[var(--ff-primary)]/8 to-transparent p-4 space-y-3 ff-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-[var(--ff-primary)]/20 flex items-center justify-center shrink-0">
            <ClipboardList size={14} className="text-[var(--ff-primary)]" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-bold text-white">Build Plan Ready</p>
            <p className="text-[10px] text-[var(--ff-text-dim)]">Review the plan before generation starts</p>
          </div>
        </div>
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="p-1 rounded-md hover:bg-white/10 text-[var(--ff-text-dim)] hover:text-white transition-colors shrink-0"
        >
          {showDetails ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
      </div>

      {/* Summary */}
      <p className="text-[11px] text-[var(--ff-text-muted)] leading-relaxed">
        {plan.summary}
      </p>

      {showDetails && (
        <>
          {/* Features */}
          {plan.features.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Sparkles size={11} className="text-[var(--ff-primary)]" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ff-text-dim)]">Features</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {plan.features.map((f, i) => (
                  <span
                    key={i}
                    className="px-2 py-0.5 rounded-full bg-[var(--ff-surface)] border border-[var(--ff-border)] text-[10px] text-[var(--ff-text-muted)]"
                  >
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Screens */}
          {plan.screens.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Layers size={11} className="text-[var(--ff-primary)]" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ff-text-dim)]">
                  Screens ({plan.screens.length})
                </span>
              </div>
              <div className="grid grid-cols-1 gap-1">
                {plan.screens.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-[var(--ff-surface)] border border-[var(--ff-border)]">
                    <FileCode2 size={11} className="text-[var(--ff-primary)] shrink-0" />
                    <span className="text-[10px] font-medium text-white shrink-0">{s.name}</span>
                    <span className="text-[10px] text-[var(--ff-text-dim)] truncate">{s.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Database tables */}
          {plan.tables.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Database size={11} className="text-[var(--ff-primary)]" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ff-text-dim)]">Database Tables</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {plan.tables.map((t, i) => (
                  <span
                    key={i}
                    className="px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-[10px] text-emerald-300 font-mono"
                  >
                    {t.name}({t.columns.slice(0, 4).join(', ')}{t.columns.length > 4 ? '...' : ''})
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Estimated files */}
          <div className="flex items-center gap-2 text-[10px] text-[var(--ff-text-dim)]">
            <FileCode2 size={10} />
            <span>~{plan.estimatedFiles} files will be generated</span>
            {plan.screens.length > 2 && (
              <span className="px-1.5 py-0.5 rounded bg-[var(--ff-primary)]/15 text-[var(--ff-primary)] font-medium">
                Parallel generation enabled
              </span>
            )}
          </div>

          {/* Clarifying questions */}
          {hasQuestions && (
            <div className="space-y-2 pt-2 border-t border-white/10">
              <div className="flex items-center gap-1.5">
                <HelpCircle size={11} className="text-amber-400" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400">
                  Clarifying Questions
                </span>
              </div>
              <p className="text-[10px] text-[var(--ff-text-dim)] leading-relaxed">
                Answer these to improve the generated code, or skip to use defaults.
              </p>
              {plan.questions.map((q, i) => (
                <div key={i} className="space-y-1">
                  <label className="text-[10px] text-[var(--ff-text-muted)] leading-relaxed block">
                    {i + 1}. {q}
                  </label>
                  <input
                    type="text"
                    value={answers[i] ?? ''}
                    onChange={(e) => handleAnswerChange(i, e.target.value)}
                    placeholder="Your answer (optional)..."
                    className="w-full ff-input px-2.5 py-1.5 text-[10px] rounded-lg placeholder:text-[var(--ff-text-dim)]"
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-2 border-t border-white/10">
        <button
          onClick={onApprove}
          className={cn(
            'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all',
            'bg-[var(--ff-primary)] hover:bg-[var(--ff-primary-hover)] text-white shadow-md shadow-[var(--ff-primary)]/20',
            'active:scale-95'
          )}
        >
          <Check size={13} />
          Approve & Generate
        </button>
        <button
          onClick={onReject}
          className="px-3 py-2 rounded-xl text-xs font-medium bg-[var(--ff-surface)] border border-[var(--ff-border)] hover:border-red-500/40 hover:bg-red-500/10 text-[var(--ff-text-muted)] hover:text-red-300 transition-all active:scale-95"
        >
          <X size={13} className="inline mr-1" />
          Cancel
        </button>
      </div>
    </div>
  );
}
