import * as React from "react";
import { cn } from "@/lib/cn";

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
        "relative overflow-hidden rounded-[14px] border border-[var(--border-raw)] bg-[var(--bg-card)] " +
          "px-5 py-4 shadow-[var(--shadow-sm)] transition-colors hover:border-[var(--border-2)]",
        className,
      )}
    >
      <div className="mb-3 flex items-center justify-between text-[12px] font-medium text-[var(--text-2)]">
        <span>{label}</span>
        {badge}
      </div>
      <div className={cn("mb-1 text-[26px] font-bold leading-none tracking-tight tabular", valueColor)}>
        {value}
      </div>
      {delta != null ? (
        <div className="text-[12px] leading-relaxed text-[var(--text-2)]">{delta}</div>
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
