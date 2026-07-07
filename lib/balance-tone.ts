/**
 * Shared color convention for a projected running balance. Used by the ledger
 * table and the calendar so "how much is left" reads the same everywhere.
 *
 *   < 0            → red      (would overdraw)
 *   0 .. cushion   → amber    (getting low)
 *   ≥ cushion      → phosphor (comfortable)
 *
 * Returns a Tailwind text-color class (a bg variant is provided for surfaces
 * that tint the whole cell). Keep the thresholds here so both views agree.
 */

/** Balances at/above this stay green; below it (but ≥0) go amber. */
export const LOW_BALANCE_CUSHION_CENTS = 500_00;

export type BalanceTone = "danger" | "warn" | "ok";

export function balanceTone(cents: number): BalanceTone {
  if (cents < 0) return "danger";
  if (cents < LOW_BALANCE_CUSHION_CENTS) return "warn";
  return "ok";
}

const TEXT: Record<BalanceTone, string> = {
  danger: "text-[var(--red)]",
  warn: "text-[var(--amber)]",
  ok: "text-[var(--phosphor)]",
};

const SURFACE: Record<BalanceTone, string> = {
  danger: "bg-[color-mix(in_oklch,var(--red)_10%,transparent)]",
  warn: "bg-[color-mix(in_oklch,var(--amber)_10%,transparent)]",
  ok: "bg-[color-mix(in_oklch,var(--phosphor)_8%,transparent)]",
};

export function balanceToneClass(cents: number): string {
  return TEXT[balanceTone(cents)];
}

export function balanceSurfaceClass(cents: number): string {
  return SURFACE[balanceTone(cents)];
}
