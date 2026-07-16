import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * Shared empty state — a centered icon + title + optional description/action.
 * Replaces the ad-hoc "nothing here" strings scattered across pages so every
 * empty view reads the same.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="grid h-11 w-11 place-items-center rounded-full border border-[var(--border-raw)] bg-[var(--bg-2)] text-[var(--text-3)]">
          {icon}
        </div>
      ) : null}
      <div className="space-y-1">
        <div className="text-[15px] font-semibold text-[var(--text-0)]">{title}</div>
        {description ? (
          <div className="mx-auto max-w-sm text-[13px] leading-relaxed text-[var(--text-2)]">
            {description}
          </div>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
