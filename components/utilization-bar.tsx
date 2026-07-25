"use client";

// Shared credit-utilization bar: balance against the card's credit line.
// Used by the credit-cards spending tab and by the calendar's card events, so
// the same card reads identically wherever it appears.

import { Money } from "@/components/money";
import { cn } from "@/lib/cn";
import { utilizationBand, type UtilizationBand } from "@/lib/card-spending";

export const BAND_LABEL: Record<UtilizationBand, string> = {
  low: "Comfortable",
  moderate: "Moderate",
  high: "Running high",
  maxed: "Nearly maxed",
};

export const BAND_BAR: Record<UtilizationBand, string> = {
  low: "bg-[var(--phosphor)]",
  moderate: "bg-[var(--cyan)]",
  high: "bg-[var(--amber)]",
  maxed: "bg-[var(--red)]",
};

export const BAND_TEXT: Record<UtilizationBand, string> = {
  low: "text-[var(--phosphor)]",
  moderate: "text-[var(--text-0)]",
  high: "text-[var(--amber)]",
  maxed: "text-[var(--red)]",
};

export function formatUtilization(ratio: number): string {
  return `${(ratio * 100).toFixed(ratio >= 0.1 ? 0 : 1)}%`;
}

/**
 * Ultra-compact utilization for a calendar chip: a hairline bar plus the
 * percentage, sized to sit inside a month-grid cell without pushing the day's
 * other events out of view. The full figures go in the chip's `title`.
 *
 * Returns null on an unknown credit line, same rule as UtilizationBar — a chip
 * is the last place that should imply a card is at 0%.
 */
export function InlineUtilization({
  balanceCents,
  limitCents,
  className,
}: {
  balanceCents: number | null;
  limitCents: number | null;
  className?: string;
}) {
  if (limitCents == null || limitCents <= 0 || balanceCents == null) return null;

  const ratio = balanceCents / limitCents;
  const band = utilizationBand(ratio);

  return (
    <div className={cn("mt-0.5 flex items-center gap-1", className)}>
      <div className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--bg-3)]">
        <div
          className={cn("h-full rounded-full", BAND_BAR[band])}
          style={{ width: `${Math.min(100, Math.max(4, ratio * 100))}%` }}
        />
      </div>
      <span className={cn("shrink-0 tabular text-[9px] leading-none", BAND_TEXT[band])}>
        {formatUtilization(ratio)}
      </span>
    </div>
  );
}

/** `92% used · $920.00 of $1,000.00`, for a chip tooltip. Null when unknown. */
export function utilizationTitle(
  balanceCents: number | null,
  limitCents: number | null,
  formatCents: (cents: number) => string,
): string | null {
  if (limitCents == null || limitCents <= 0 || balanceCents == null) return null;
  const ratio = balanceCents / limitCents;
  return `${formatUtilization(ratio)} used · ${formatCents(balanceCents)} of ${formatCents(limitCents)}`;
}

export function UtilizationBar({
  balanceCents,
  limitCents,
  compact = false,
  className,
}: {
  /** Current balance. Null renders nothing — see the note on limitCents. */
  balanceCents: number | null;
  /**
   * Credit line. Null means UNKNOWN, not zero: the component renders nothing
   * rather than implying 0% used. Callers that want an explicit "no limit set"
   * hint should render it themselves when this returns null.
   */
  limitCents: number | null;
  /** Tighter type/spacing for dialogs and event rows. */
  compact?: boolean;
  className?: string;
}) {
  if (limitCents == null || limitCents <= 0 || balanceCents == null) return null;

  const ratio = balanceCents / limitCents;
  const band = utilizationBand(ratio);
  const headroomCents = limitCents - balanceCents;

  return (
    <div className={cn(compact ? "space-y-1" : "space-y-1.5", className)}>
      <div
        className={cn(
          "flex items-baseline justify-between gap-3",
          compact ? "text-2xs" : "text-[12px]",
        )}
      >
        <span className={cn("font-semibold tabular", BAND_TEXT[band])}>
          {formatUtilization(ratio)} used
        </span>
        <span className="tabular text-[var(--text-2)]">
          <Money cents={balanceCents} /> of <Money cents={limitCents} />
        </span>
      </div>
      <div
        className={cn(
          "w-full overflow-hidden rounded-full bg-[var(--bg-3)]",
          compact ? "h-1.5" : "h-2",
        )}
      >
        <div
          className={cn("h-full rounded-full transition-all", BAND_BAR[band])}
          // Over-limit clamps the BAR at 100% (it can't overflow its track)
          // while the label above still reads the true >100% figure. The 2%
          // floor keeps a sliver visible at a near-zero balance.
          style={{ width: `${Math.min(100, Math.max(2, ratio * 100))}%` }}
        />
      </div>
      <div className="text-2xs text-[var(--text-3)]">
        {headroomCents >= 0 ? (
          <>
            <Money cents={headroomCents} /> left before the limit
          </>
        ) : (
          <span className="text-[var(--red)]">
            <Money cents={Math.abs(headroomCents)} /> over the limit
          </span>
        )}
      </div>
    </div>
  );
}
