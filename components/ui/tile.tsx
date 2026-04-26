import * as React from "react";
import { cn } from "@/lib/cn";

/* FINANCE_OS KPI tile: dark card with optional corner brackets, label,
   value, and small delta line. */
export function Tile({
  label,
  value,
  delta,
  badge,
  variant = "default",
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  delta?: React.ReactNode;
  badge?: React.ReactNode;
  variant?: "default" | "mint" | "red" | "amber";
  className?: string;
}) {
  const valueColor = {
    default: "",
    mint: "text-[var(--mint)]",
    red: "text-[var(--red)]",
    amber: "text-[var(--amber)]",
  }[variant];

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-sm border border-[var(--border-raw)] bg-[var(--bg-card)] " +
          "px-[18px] py-4 transition-colors hover:border-[var(--border-2)]",
        className,
      )}
    >
      <span className="absolute right-2 top-2 h-2 w-2 border-r border-t border-[var(--mint-dim)]" />
      <span className="absolute bottom-2 left-2 h-2 w-2 border-b border-l border-[var(--mint-dim)]" />

      <div className="mb-3 flex items-center justify-between text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-2)]">
        <span>{label}</span>
        {badge}
      </div>
      <div className={cn("mb-1 text-[26px] font-bold leading-none tracking-tight tabular", valueColor)}>
        {value}
      </div>
      {delta != null ? (
        <div className="text-[10px] tracking-wide text-[var(--text-2)]">{delta}</div>
      ) : null}
    </div>
  );
}

export function TileGrid({
  children,
  className,
  cols,
}: {
  children: React.ReactNode;
  className?: string;
  cols?: 2 | 3 | 4 | "auto";
}) {
  const colsClass =
    cols === 2
      ? "grid-cols-2"
      : cols === 3
        ? "grid-cols-3"
        : cols === 4
          ? "grid-cols-2 lg:grid-cols-4"
          : "grid-cols-[repeat(auto-fit,minmax(220px,1fr))]";
  return <div className={cn("grid gap-3.5", colsClass, className)}>{children}</div>;
}
