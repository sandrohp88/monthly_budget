import { Money } from "@/components/money";
import { cn } from "@/lib/cn";
import type { CategoryUtilization } from "@/lib/repos";

export function BudgetUtilization({
  rows,
}: {
  rows: CategoryUtilization[];
}) {
  if (rows.length === 0) return null;

  return (
    <div className="space-y-3">
      {rows.map((r) => {
        const pct = r.budgetCents > 0 ? Math.min((r.spentCents / r.budgetCents) * 100, 100) : 0;
        const over = r.spentCents > r.budgetCents;
        const overPct = over
          ? Math.min(((r.spentCents - r.budgetCents) / r.budgetCents) * 100, 100)
          : 0;

        return (
          <div key={r.category}>
            <div className="mb-1.5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: r.color }}
                />
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-1)]">
                  {r.category}
                </span>
              </div>
              <div className="flex items-center gap-2 tabular text-[10px] tracking-[0.08em]">
                <span className={cn(over ? "text-[var(--red)]" : "text-[var(--text-1)]")}>
                  <Money cents={r.spentCents} />
                </span>
                <span className="text-[var(--text-3)]">/</span>
                <span className="text-[var(--text-2)]">
                  <Money cents={r.budgetCents} />
                </span>
              </div>
            </div>
            <div className="relative h-1.5 w-full overflow-hidden bg-[var(--bg-2)]">
              <div
                className={cn(
                  "absolute inset-y-0 left-0 transition-all",
                  over ? "bg-[var(--red)]" : "bg-[var(--cyan)]",
                )}
                style={{ width: `${pct}%` }}
              />
              {over && (
                <div
                  className="absolute inset-y-0 bg-[var(--red)] opacity-40"
                  style={{ left: `${100 - overPct}%`, width: `${overPct}%` }}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
