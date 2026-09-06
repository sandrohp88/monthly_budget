import { daysBetween } from "./dates";
import { draftNamesBill, type ReconcilableDraft } from "./bill-reconciliation";

export type PlannedCardPayment = {
  cardId: string;
  cardName: string;
  date: string;
  amountCents: number;
};

export const cardPaymentKey = (cardId: string, date: string) => `${cardId}:${date}`;

export type CardPaymentReceipt = { cardId: string; date: string; amountCents: number };

/** Posted CHECKING debits only, supplied by the user-scoped balance-account
 * query. A card-side credit or a paid statement cannot prove checking posted.
 * Explicit allocations win; automatic matches require an exact amount, card
 * name, payment wording, and a unique pairing within -3/+14 days. Ambiguity
 * keeps cash reserved for the user to link, rather than guessing it away.
 */
export function reconcilePlannedCardPayments(
  plans: readonly PlannedCardPayment[],
  drafts: readonly ReconcilableDraft[],
  excludedDraftIds: ReadonlySet<string> = new Set(),
  cardReceipts: readonly CardPaymentReceipt[] = [],
): Map<string, number> {
  const posted = new Map<string, number>();
  const planKeys = new Set(plans.map((p) => cardPaymentKey(p.cardId, p.date)));
  const explicitlyAssigned = new Set<string>();
  for (const d of drafts) {
    if (d.amountCents <= 0) continue;
    for (const a of d.allocations ?? []) {
      if (a.targetKind !== "card_payment") continue;
      const key = cardPaymentKey(a.targetId, a.targetDate);
      if (!planKeys.has(key)) continue;
      explicitlyAssigned.add(key);
      posted.set(key, (posted.get(key) ?? 0) + a.amountCents);
    }
  }

  const pairs: Array<{ key: string; draftId: string; cents: number }> = [];
  for (const p of plans) {
    const key = cardPaymentKey(p.cardId, p.date);
    if (explicitlyAssigned.has(key)) continue;
    // Remove only a conventional last-four suffix, never arbitrary numbers.
    const name = p.cardName.replace(/\s*\(?\*{2,}\d{4}\)?\s*$/, "").trim();
    for (const d of drafts) {
      if (excludedDraftIds.has(d.id) || d.linkedBillId || d.allocations?.length) continue;
      if (d.amountCents !== p.amountCents || d.amountCents <= 0) continue;
      const gap = daysBetween(p.date, d.date);
      if (gap < -3 || gap > 14) continue;
      const namedPayment = /\b(payment|pmt|autopay|epay)\b/i.test(d.description) && draftNamesBill(name, d);
      // A linked card receipt identifies the destination when checking uses
      // an issuer name instead of the user's card nickname. Still require a
      // distinct posted checking debit: the credit leg alone frees no cash.
      const receipt = cardReceipts.some((r) => r.cardId === p.cardId &&
        r.amountCents === d.amountCents && Math.abs(daysBetween(d.date, r.date)) <= 3);
      if (!namedPayment && !receipt) continue;
      pairs.push({ key, draftId: d.id, cents: d.amountCents });
    }
  }
  for (const pair of pairs) {
    if (pairs.filter((p) => p.key === pair.key).length !== 1) continue;
    if (pairs.filter((p) => p.draftId === pair.draftId).length !== 1) continue;
    posted.set(pair.key, pair.cents);
  }
  return posted;
}
