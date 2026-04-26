"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

/* Inline alert ribbon used above tables/charts. */
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
      wrap: "bg-[rgba(251,191,36,0.08)] border-[rgba(251,191,36,0.25)]",
      tag: "bg-[var(--amber)] text-[var(--bg-0)]",
    },
    mint: {
      wrap: "bg-[rgba(74,222,128,0.06)] border-[rgba(74,222,128,0.25)]",
      tag: "bg-[var(--mint)] text-[var(--bg-0)]",
    },
    red: {
      wrap: "bg-[var(--red-glow)] border-[rgba(239,68,68,0.3)]",
      tag: "bg-[var(--red)] text-white",
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
