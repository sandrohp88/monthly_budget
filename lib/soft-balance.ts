/**
 * When to show the POSTED balance next to the soft one.
 *
 * The app's primary number is the soft balance — what's actually left once
 * money already on its way out clears. The posted balance answers a different
 * question ("what does my bank app show right now?"), and it's only worth the
 * screen space when the two disagree.
 *
 * Two conditions, both necessary:
 *
 *   - The row is today or earlier. Nothing in the future has "posted", so a
 *     posted figure on a future day would be asserting that a payment already
 *     in flight might never land. Every in-flight item is dated today or
 *     earlier, so past today the two series simply run parallel at a constant
 *     gap — real arithmetic, but a meaningless thing to display.
 *   - The two actually differ. No in-flight cash on this row, one number.
 *
 * Pure and shared so the calendar, ledger, dashboard agenda and chart can't
 * drift into showing the pair under different rules.
 */
export function showsPostedBalance(
  row: { date: string; balanceCents: number; postedBalanceCents: number },
  today: string,
): boolean {
  return row.date <= today && row.postedBalanceCents !== row.balanceCents;
}
