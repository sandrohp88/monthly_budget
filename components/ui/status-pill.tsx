import * as React from "react";
import { cn } from "@/lib/cn";

/* A pill smaller than Badge with a 1px border and uppercase text. Used inline
   in tables and cards to mark row state. */
export function StatusPill({
  children,
  variant = "default",
  className,
}: {
  children: React.ReactNode;
  variant?: "default" | "warn" | "off" | "danger" | "amber";
  className?: string;
}) {
  const map: Record<string, string> = {
    default: "bg-[var(--mint-glow)] text-[var(--mint)] border-[var(--mint-dim)]",
    warn: "bg-[rgba(251,191,36,0.1)] text-[var(--amber)] border-[rgba(251,191,36,0.3)]",
    amber: "bg-[rgba(251,191,36,0.1)] text-[var(--amber)] border-[rgba(251,191,36,0.3)]",
    off: "bg-[rgba(107,122,112,0.1)] text-[var(--text-2)] border-[var(--border-2)]",
    danger: "bg-[var(--red-glow)] text-[var(--red)] border-[rgba(239,68,68,0.3)]",
  };

  return (
    <span
      className={cn(
        "inline-block rounded-sm border px-2 py-[3px] text-[9px] font-medium uppercase tracking-[0.12em] font-mono",
        map[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
