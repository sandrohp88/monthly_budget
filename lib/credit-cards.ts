import { addDaysIso } from "@/lib/dates";
import { computeProjection } from "@/lib/projection";
import type { BillRow, CreditCardRow, CreditCardStatementRow } from "@/lib/db/schema";

/** Clamp a day-of-month to the actual number of days in that month (UTC). */
function clampDay(year: number, month: number, day: number): number {
  // month is 1..12 here
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(day, lastDay);
}

function isoOf(year: number, month: number, day: number): string {
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

/**
 * Next occurrence of `dayOfMonth` strictly on/after `fromIso`. Months with
 * fewer days clamp (e.g. dueDay=31 in February → Feb 28/29).
 */
export function nextDayOfMonthOnOrAfter(fromIso: string, dayOfMonth: number): string {
  const [yStr, mStr, dStr] = fromIso.split("-");
  let year = Number(yStr);
  let month = Number(mStr);
  const fromDay = Number(dStr);
  const candidate = clampDay(year, month, dayOfMonth);
  if (candidate >= fromDay) return isoOf(year, month, candidate);
  // Roll to next month
  month += 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }
  return isoOf(year, month, clampDay(year, month, dayOfMonth));
}

/**
 * Given a statement date and the card's dueDay, compute the matching due date
 * for that statement. Heuristic: due date is the next occurrence of `dueDay`
 * that is at least 14 days after the statement (most US issuers grant 21–25).
 */
export function dueDateFromStatement(statementIso: string, dueDay: number): string {
  // Start looking 14 days out
  const earliest = addDaysIso(statementIso, 14);
  return nextDayOfMonthOnOrAfter(earliest, dueDay);
}

/** A statement is "unpaid" if no paid amount has been recorded. */
export function isStatementOpen(s: CreditCardStatementRow): boolean {
  return s.paidAmountCents == null;
}

/** Did the user pay the full statement on or before the due date? */
export function paidWithoutInterest(s: CreditCardStatementRow): boolean {
  if (s.paidAmountCents == null || s.paidDate == null) return false;
  return s.paidAmountCents >= s.statementBalanceCents && s.paidDate <= s.dueDate;
}

/** Sum of unpaid balances across a list of statements. */
export function totalDue(statements: ReadonlyArray<CreditCardStatementRow>): number {
  return statements
    .filter(isStatementOpen)
    .reduce((sum, s) => sum + s.statementBalanceCents, 0);
}

/**
 * Pick the most relevant statement to surface on the card UI:
 *   1. Earliest unpaid (so user sees what's due soonest)
 *   2. Otherwise, most recent paid (so they see history)
 */
export function currentStatementOf(
  statements: ReadonlyArray<CreditCardStatementRow>,
): CreditCardStatementRow | undefined {
  const unpaid = statements.filter(isStatementOpen);
  if (unpaid.length > 0) {
    return [...unpaid].sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  }
  if (statements.length === 0) return undefined;
  return [...statements].sort((a, b) => b.statementDate.localeCompare(a.statementDate))[0];
}

/** Number of days between two ISO dates (UTC, may be negative). */
export function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.round((db - da) / (1000 * 60 * 60 * 24));
}

export type CardWithStatements = {
  card: CreditCardRow;
  statements: CreditCardStatementRow[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Next-cycle estimate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The card's open billing cycle is the window between the previous statement
 * close and the next one. Charges that land in this window appear on the next
 * statement. Returned dates are inclusive on both ends.
 */
export function currentCycleWindow(
  card: { statementDay: number },
  fromIso: string,
): { start: string; end: string } {
  const end = nextDayOfMonthOnOrAfter(fromIso, card.statementDay);
  // Previous close = same day-of-month, one calendar month earlier (clamped)
  const [yStr, mStr] = end.split("-");
  let year = Number(yStr);
  let month = Number(mStr) - 1;
  if (month < 1) {
    month = 12;
    year -= 1;
  }
  const prevClose = isoOf(year, month, clampDay(year, month, card.statementDay));
  return { start: addDaysIso(prevClose, 1), end };
}

export type LinkedBillEstimate = {
  billId: string;
  name: string;
  date: string;       // when it lands in this cycle
  amountCents: number;
};

/**
 * Compute every charge expected to hit the card in its current open cycle by
 * running the linked bills through the existing projection engine. Reusing
 * computeProjection means leap-year, day-clamp, and month-roll behavior stay
 * consistent with the daily ledger.
 */
export function estimateCurrentCycle(
  card: { statementDay: number; dueDay: number },
  linkedBills: ReadonlyArray<BillRow>,
  fromIso: string,
): { window: { start: string; end: string }; charges: LinkedBillEstimate[]; totalCents: number } {
  const window = currentCycleWindow(card, fromIso);
  if (linkedBills.length === 0) {
    return { window, charges: [], totalCents: 0 };
  }

  const rows = computeProjection({
    startingBalanceCents: 0,
    startDate: window.start,
    endDate: window.end,
    bills: linkedBills.map((b) => ({
      id: b.id,
      name: b.name,
      amountCents: b.amountCents,
      frequency: b.frequency,
      dueDay: b.dueDay,
      dueMonth: b.dueMonth,
    })),
    paychecks: [],
    extras: [],
  });

  const charges: LinkedBillEstimate[] = [];
  for (const row of rows) {
    for (const ev of row.events) {
      if (ev.kind !== "bill") continue;
      // Find the source bill so we can preserve the row id (multiple bills
      // may have the same display label)
      const source = linkedBills.find((b) => b.name === ev.label) ?? linkedBills[0]!;
      charges.push({
        billId: source.id,
        name: ev.label,
        date: row.date,
        amountCents: ev.amountCents,
      });
    }
  }
  const totalCents = charges.reduce((s, c) => s + c.amountCents, 0);
  return { window, charges, totalCents };
}

