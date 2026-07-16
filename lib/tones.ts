/**
 * Semantic tone system — one source of truth for the "soft chip" look shared
 * by Badge and StatusPill (tinted fill + matching border + colored text), plus
 * a solid text variant for inline emphasis.
 *
 * Components keep their own public `variant` props; they translate those to a
 * canonical `Tone` here so every surface renders the same tone identically.
 * Colors come from theme tokens, so all six themes stay coherent.
 */
export type Tone = "primary" | "success" | "warning" | "danger" | "neutral" | "muted";

/** Soft chip: tinted fill + matching border + colored text. Badges, status pills. */
export const toneChip: Record<Tone, string> = {
  primary: "border-[var(--mint-dim)] bg-[var(--mint-glow)] text-[var(--mint)]",
  success:
    "border-[color-mix(in_oklch,var(--success)_35%,transparent)] bg-[color-mix(in_oklch,var(--success)_14%,transparent)] text-[var(--success)]",
  warning:
    "border-[color-mix(in_oklch,var(--amber)_30%,transparent)] bg-[color-mix(in_oklch,var(--amber)_10%,transparent)] text-[var(--amber)]",
  danger:
    "border-[color-mix(in_oklch,var(--red)_30%,transparent)] bg-[var(--red-glow)] text-[var(--red)]",
  neutral: "border-[var(--border-2)] bg-[var(--bg-3)] text-[var(--text-1)]",
  muted:
    "border-[var(--border-2)] bg-[color-mix(in_oklch,var(--text-2)_10%,transparent)] text-[var(--text-2)]",
};

/** Solid text color only — numeric values, deltas, inline emphasis. */
export const toneText: Record<Tone, string> = {
  primary: "text-[var(--mint)]",
  success: "text-[var(--success)]",
  warning: "text-[var(--amber)]",
  danger: "text-[var(--red)]",
  neutral: "text-[var(--text-0)]",
  muted: "text-[var(--text-2)]",
};
