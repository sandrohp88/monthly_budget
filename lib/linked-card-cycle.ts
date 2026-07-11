import { addDaysIso, daysBetween } from "./dates";

const MIN_CARD_CYCLE_DAYS = 26;
const MAX_CARD_CYCLE_DAYS = 35;

export type InferredLinkedCardCycle = {
  anchorDate: string;
  intervalDays: number;
  source: "statements" | "payments";
};

function uniqueSortedDates(dates: readonly string[]): string[] {
  return [...new Set(dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
}

function medianRounded(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function inferInterval(
  dates: readonly string[],
  options: { minDays: number; maxDays: number; minGaps: number },
): number | null {
  const sorted = uniqueSortedDates(dates);
  const gaps: number[] = [];
  for (let index = 1; index < sorted.length; index++) {
    const gap = daysBetween(sorted[index - 1]!, sorted[index]!);
    if (gap >= options.minDays && gap <= options.maxDays) gaps.push(gap);
  }
  if (gaps.length < options.minGaps) return null;
  return medianRounded(gaps);
}

/**
 * Infer a linked card's rolling statement cycle from observed history.
 *
 * Actual statement dates are the best signal. When Plaid only exposes one
 * statement, recurring posted card-payment transactions still reveal the
 * cadence. Payment dates are not statement-close dates, so the latest known
 * statement remains the anchor; without one, the anchor is conservatively
 * estimated by walking back the card's configured grace period.
 */
export function inferLinkedCardCycle(input: {
  statementDates: readonly string[];
  paymentDates: readonly string[];
  gracePeriodDays: number;
}): InferredLinkedCardCycle | null {
  const statements = uniqueSortedDates(input.statementDates);
  const payments = uniqueSortedDates(input.paymentDates);
  const statementInterval = inferInterval(statements, {
    minDays: MIN_CARD_CYCLE_DAYS,
    maxDays: MAX_CARD_CYCLE_DAYS,
    minGaps: 1,
  });
  const paymentInterval =
    statementInterval == null
      ? inferInterval(payments, { minDays: 26, maxDays: 35, minGaps: 2 })
      : null;
  const intervalDays = statementInterval ?? paymentInterval;
  if (intervalDays == null) return null;

  const latestStatement = statements.at(-1);
  const latestPayment = payments.at(-1);
  if (!latestStatement && !latestPayment) return null;

  return {
    anchorDate:
      latestStatement ?? addDaysIso(latestPayment!, -Math.max(0, input.gracePeriodDays)),
    intervalDays,
    source: statementInterval == null ? "payments" : "statements",
  };
}
