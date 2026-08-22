/**
 * Pure helpers used by the Plaid sync layer. Kept in their own file (no
 * "server-only" import) so they're directly unit-testable.
 */

import { dollarsToCents } from "./money";

/**
 * Category strings that indicate a payment or transfer rather than a purchase
 * (Plaid `personal_finance_category` primaries like LOAN_PAYMENTS, TRANSFER_*,
 * and legacy category labels). Shared by the PayPal financing classifiers and
 * the promo-candidate check — keep the single source of truth here.
 */
export function isPaymentLikeCategory(category: string | null | undefined): boolean {
  const value = category?.toLowerCase() ?? "";
  return value.includes("payment") || value.includes("transfer");
}

/** Plaid sends amounts as positive for debits and negative for credits.
 *  We store positive = expense, negative = refund — same sign convention.
 *  Plaid amounts are in dollars (floating point); routing through
 *  `dollarsToCents` rounds on the decimal digits Plaid actually emitted
 *  rather than on the IEEE-754 product, so refunds at -x.xx5 don't drift
 *  one cent toward zero. */
export function toCents(plaidAmount: number): number {
  return dollarsToCents(plaidAmount);
}

/**
 * Pull Plaid's `error_code` out of a thrown SDK error.
 *
 * The Plaid node SDK throws axios errors, so the useful code is buried at
 * `err.response.data.error_code` while `err.message` is just the HTTP status
 * ("Request failed with status code 429") — useless for telling a rate limit
 * apart from a dead institution. Fully defensive: any shape that isn't a Plaid
 * error body returns null rather than throwing inside a catch block.
 */
export function plaidErrorCode(err: unknown): string | null {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data;
  if (typeof data !== "object" || data === null) return null;
  const code = (data as { error_code?: unknown }).error_code;
  return typeof code === "string" ? code : null;
}

/**
 * Decide whether the Plaid liabilities snapshot indicates the current
 * statement was paid in full on time. Mirrors the manual `paidWithoutInterest`
 * helper in lib/credit-cards.ts but works against Plaid's "last payment"
 * fields rather than a stored statement row.
 *
 * Returns true when:
 *   - Plaid reports a last payment date and amount,
 *   - the payment date is on or after the statement issue date, AND
 *   - the payment amount covers (or exceeds) the statement cash due.
 *
 * When Plaid reports a $0 statement balance with a non-zero minimum payment
 * (PayPal special financing), the minimum payment is the amount to test.
 *
 * When the card carries active 0% promos, `interestSavingDueCents` (computed
 * by the caller via `interestSavingCashDueCents`) lowers the bar: paying the
 * Interest Saving Balance avoids interest without prematurely clearing the
 * promo principal, so it counts as paid.
 *
 * String comparison on ISO YYYY-MM-DD is chronologically correct.
 */
export function looksLikePaid(args: {
  lastPaymentDate: string | null | undefined;
  lastPaymentCents: number | null | undefined;
  statementDate: string;
  statementBalanceCents: number;
  minimumPaymentCents?: number | null;
  interestSavingDueCents?: number | null;
}): boolean {
  const {
    lastPaymentDate,
    lastPaymentCents,
    statementDate,
    statementBalanceCents,
    minimumPaymentCents,
    interestSavingDueCents,
  } = args;
  const rawDueCents =
    statementBalanceCents > 0 ? statementBalanceCents : (minimumPaymentCents ?? 0);
  const dueCents =
    interestSavingDueCents != null ? Math.min(rawDueCents, interestSavingDueCents) : rawDueCents;
  return (
    lastPaymentDate != null &&
    lastPaymentCents != null &&
    lastPaymentDate >= statementDate &&
    lastPaymentCents >= dueCents
  );
}
