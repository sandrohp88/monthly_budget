/**
 * Pure helpers used by the Plaid sync layer. Kept in their own file (no
 * "server-only" import) so they're directly unit-testable.
 */

/** Plaid sends amounts as positive for debits and negative for credits.
 *  We store positive = expense, negative = refund — same sign convention.
 *  Plaid amounts are in dollars (floating point); we multiply by 100 and round. */
export function toCents(plaidAmount: number): number {
  return Math.round(plaidAmount * 100);
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
 * String comparison on ISO YYYY-MM-DD is chronologically correct.
 */
export function looksLikePaid(args: {
  lastPaymentDate: string | null | undefined;
  lastPaymentCents: number | null | undefined;
  statementDate: string;
  statementBalanceCents: number;
  minimumPaymentCents?: number | null;
}): boolean {
  const {
    lastPaymentDate,
    lastPaymentCents,
    statementDate,
    statementBalanceCents,
    minimumPaymentCents,
  } = args;
  const dueCents = statementBalanceCents > 0 ? statementBalanceCents : (minimumPaymentCents ?? 0);
  return (
    lastPaymentDate != null &&
    lastPaymentCents != null &&
    lastPaymentDate >= statementDate &&
    lastPaymentCents >= dueCents
  );
}
