import * as React from "react";
import { cn } from "@/lib/cn";

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
        "inline-block rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-normal",
        map[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
