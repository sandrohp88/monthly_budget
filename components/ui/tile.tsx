import * as React from "react";
import { cn } from "@/lib/cn";

export function Tile({
  label,
  value,
  delta,
  badge,
  variant = "default",
  compact = false,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  delta?: React.ReactNode;
  badge?: React.ReactNode;
  variant?: "default" | "mint" | "red" | "amber";
  compact?: boolean;
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
        "relative overflow-hidden rounded-lg border border-[var(--border-raw)] bg-[var(--bg-card)] shadow-[var(--shadow-sm)] transition-colors hover:border-[var(--border-2)]",
        compact ? "px-3.5 py-3" : "px-5 py-4",
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between font-medium text-[var(--text-2)]",
          compact ? "mb-1.5 text-[11px]" : "mb-3 text-[12px]",
        )}
      >
        <span>{label}</span>
        {badge}
      </div>
      <div
        className={cn(
          "font-bold leading-none tracking-tight tabular",
          compact ? "mb-0.5 text-[20px]" : "mb-1 text-[26px]",
          valueColor,
        )}
      >
        {value}
      </div>
      {delta != null ? (
        <div
          className={cn(
            "text-[var(--text-2)]",
            compact ? "text-[11px] leading-snug" : "text-[12px] leading-relaxed",
          )}
        >
          {delta}
        </div>
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
          : "grid-cols-[repeat(auto-fit,minmax(180px,1fr))]";
  return <div className={cn("grid gap-2.5", colsClass, className)}>{children}</div>;
}
