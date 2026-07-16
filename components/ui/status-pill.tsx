import * as React from "react";
import { cn } from "@/lib/cn";
import { toneChip, type Tone } from "@/lib/tones";

// Public variants map to canonical tones so StatusPill and Badge stay visually
// identical for the same semantic meaning (see lib/tones.ts).
const VARIANT_TONE: Record<string, Tone> = {
  default: "primary",
  warn: "warning",
  amber: "warning",
  off: "muted",
  danger: "danger",
};

export function StatusPill({
  children,
  variant = "default",
  className,
}: {
  children: React.ReactNode;
  variant?: "default" | "warn" | "off" | "danger" | "amber";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block rounded-full border px-2.5 py-1 text-2xs font-medium tracking-normal",
        toneChip[VARIANT_TONE[variant] ?? "primary"],
        className,
      )}
    >
      {children}
    </span>
  );
}
