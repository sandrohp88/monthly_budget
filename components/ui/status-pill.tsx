import * as React from "react";
import { cn } from "@/lib/cn";

/* A pill smaller than Badge with a 1px border and uppercase text. Used inline
   in tables and cards to mark row state. Variant colors derive from theme
   tokens via color-mix() so every theme (phosphor, daylight, high-contrast)
   gets a coherent fill/border. */
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
    warn: "bg-[color-mix(in_oklch,var(--amber)_10%,transparent)] text-[var(--amber)] border-[color-mix(in_oklch,var(--amber)_30%,transparent)]",
    amber: "bg-[color-mix(in_oklch,var(--amber)_10%,transparent)] text-[var(--amber)] border-[color-mix(in_oklch,var(--amber)_30%,transparent)]",
    off: "bg-[color-mix(in_oklch,var(--text-2)_10%,transparent)] text-[var(--text-2)] border-[var(--border-2)]",
    danger: "bg-[var(--red-glow)] text-[var(--red)] border-[color-mix(in_oklch,var(--red)_30%,transparent)]",
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
