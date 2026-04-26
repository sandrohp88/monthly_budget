import { addDaysIso } from "@/lib/dates";
import type { CreditCardRow, CreditCardStatementRow } from "@/lib/db/schema";

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
