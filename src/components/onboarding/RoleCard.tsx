import type { LucideIcon } from "lucide-react";

/**
 * Entry card for one role on the welcome hub. `commitments` exists so the maker card can state
 * its obligations (time-locked funds, staying online) before the user commits — "earn fees"
 * must not read as passive income.
 */
export function RoleCard({
  icon: Icon,
  kicker,
  title,
  summary,
  commitments,
  actionLabel,
  onSelect,
}: {
  icon: LucideIcon;
  kicker: string;
  title: string;
  summary: string;
  commitments?: string[];
  actionLabel: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex flex-col rounded-card border border-line-strong bg-surface-raised/50 p-6 text-left transition-colors hover:border-primary/55 hover:bg-primary/[0.05]"
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-control border border-primary/35 bg-primary/10 text-primary">
        <Icon size={21} strokeWidth={1.8} />
      </span>
      <span className="mt-4 font-mono text-[10px] uppercase tracking-[0.14em] text-subtle">{kicker}</span>
      <strong className="mt-1 font-header text-[17px] font-bold text-foreground">{title}</strong>
      <span className="mt-2 text-[12.5px] leading-relaxed text-muted">{summary}</span>

      {commitments && (
        <span className="mt-4 flex flex-col gap-1.5 border-t border-dashed border-line pt-3.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-subtle">Before you start</span>
          {commitments.map((line) => (
            <span key={line} className="flex gap-2 text-[11.5px] leading-relaxed text-muted">
              <span className="mt-[6px] h-1 w-1 flex-none rounded-full bg-warning" />
              {line}
            </span>
          ))}
        </span>
      )}

      <span className="mt-5 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-primary group-hover:text-primary-hover">
        {actionLabel} →
      </span>
    </button>
  );
}
