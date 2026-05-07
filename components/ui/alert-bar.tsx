"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

/* Inline alert ribbon used above tables/charts. Variant fills derive from
   theme tokens via color-mix() so every theme reads coherently. */
export function AlertBar({
  tag = "ALERT",
  variant = "amber",
  children,
  onDismiss,
  className,
}: {
  tag?: string;
  variant?: "amber" | "mint" | "red";
  children: React.ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  const tone = {
    amber: {
      wrap: "bg-[color-mix(in_oklch,var(--amber)_8%,transparent)] border-[color-mix(in_oklch,var(--amber)_25%,transparent)]",
      tag: "bg-[var(--amber)] text-[var(--bg-0)]",
    },
    mint: {
      wrap: "bg-[color-mix(in_oklch,var(--mint)_6%,transparent)] border-[color-mix(in_oklch,var(--mint)_25%,transparent)]",
      tag: "bg-[var(--mint)] text-[var(--bg-0)]",
    },
    red: {
      wrap: "bg-[var(--red-glow)] border-[color-mix(in_oklch,var(--red)_30%,transparent)]",
      tag: "bg-[var(--red)] text-[var(--text-0)]",
    },
  }[variant];

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-sm border px-4 py-3 text-[11px] text-[var(--text-1)]",
        tone.wrap,
        className,
      )}
    >
      <span
        className={cn(
          "rounded-sm px-2 py-[3px] text-[9px] font-bold uppercase tracking-[0.15em]",
          tone.tag,
        )}
      >
        {tag}
      </span>
      <div className="flex-1">{children}</div>
      {onDismiss ? (
        <button
          onClick={onDismiss}
          className="text-[var(--text-2)] hover:text-[var(--text-0)] cursor-pointer"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}
