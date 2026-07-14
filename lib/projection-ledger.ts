import type { ProjectionRow } from "./projection";

export type LedgerSummary = {
  openingBalanceCents: number;
  closingBalanceCents: number;
  netDeltaCents: number;
  totalIncomeCents: number;
  totalExpenseCents: number;
  eventCount: number;
  cardEventCount: number;
  negativeDayCount: number;
  lowPoint: ProjectionRow | null;
  nextEvent: ProjectionRow | null;
};

/**
 * Summarize a projection window for the ledger header.
 *
 * Opening/closing balances and income/expense totals span the whole window
 * (which, for a linked account with a past `startingBalanceAsOf`, can begin
 * before today). But the low-balance signals — the "low water" point and the
 * negative-day count — only look forward from `today`: a low balance that has
 * already happened isn't actionable and shouldn't keep being flagged.
 */
export function buildLedgerSummary(
  windowRows: ProjectionRow[],
  eventRows: ProjectionRow[],
  today: string,
): LedgerSummary {
  const firstRow = windowRows[0] ?? null;
  const lastRow = windowRows[windowRows.length - 1] ?? null;
  const openingBalanceCents = firstRow
    ? firstRow.balanceCents - firstRow.incomeCents + firstRow.expenseCents
    : 0;
  const closingBalanceCents = lastRow?.balanceCents ?? openingBalanceCents;
  // A low balance that already happened isn't actionable — only surface the
  // lowest point (and negative days) from today forward. If the window is
  // entirely in the past, there's no upcoming low to flag.
  const upcomingRows = windowRows.filter((row) => row.date >= today);
  const lowPoint =
    upcomingRows.length === 0
      ? null
      : upcomingRows.reduce((lowest, row) => (row.balanceCents < lowest.balanceCents ? row : lowest));
  const nextEvent = eventRows.find((row) => row.date >= today) ?? eventRows[0] ?? null;

  return {
    openingBalanceCents,
    closingBalanceCents,
    netDeltaCents: closingBalanceCents - openingBalanceCents,
    totalIncomeCents: windowRows.reduce((total, row) => total + row.incomeCents, 0),
    totalExpenseCents: windowRows.reduce((total, row) => total + row.expenseCents, 0),
    eventCount: eventRows.reduce((total, row) => total + row.events.length, 0),
    cardEventCount: eventRows.reduce(
      (total, row) =>
        total + row.events.filter((event) => event.sourceType === "creditCardPayment").length,
      0,
    ),
    negativeDayCount: upcomingRows.filter((row) => row.balanceCents < 0).length,
    lowPoint,
    nextEvent,
  };
}
