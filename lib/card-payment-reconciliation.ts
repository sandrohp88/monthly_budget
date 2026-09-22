import { daysBetween } from "./dates";
import { draftNamesBill, splitIsValid, type ReconcilableDraft } from "./bill-reconciliation";

export type PlannedCardPayment = {
  cardId: string;
  cardName: string;
  date: string;
  amountCents: number;
  /**
   * Institution of the card's linked Plaid item (e.g. "Capital One" for a
   * Quicksilver). Checking descriptors usually name the ISSUER, not the
   * user's nickname for the card, so this is a second name to match on.
   */
  issuerName?: string | null;
};

/**
 * A posted payment this close to its plan IS the plan: planned amounts are
 * typed as round figures ($903.00) while the bank posts the real statement
 * amount ($902.35). Settling it in full stops a few cents sitting "awaiting
 * post" forever (Lisette's Sam's Club plan, 2026-09-21). Anything further off
 * is a genuine partial payment and releases only what posted.
 */
export const NEAR_AMOUNT_CENTS = 100;

const PAYMENT_WORDING = /\b(payment|pmt|pymt|pymnt|paymnt|autopay|epay)\b/i;
const TRANSFER_WORDING = /\b(xfer|transfer)\b/i;
const GENERIC_ISSUER_WORDS = /\b(credit\s*cards?|cards?|bank|n\.?a\.?|financial|services|inc\.?)\b/gi;

/** The card nickname, minus a last-four suffix, then minus short/numeric words
 *  ("Discover it ****4474" -> "Discover"). Both forms are tried. */
function cardNameVariants(cardName: string): string[] {
  const base = cardName.replace(/\s*\(?\*{2,}\d{4}\)?\s*$/, "").trim();
  const significant = base
    .split(/\s+/)
    .filter((w) => w.replace(/[^a-z0-9]/gi, "").length >= 3 && !/^\d+$/.test(w))
    .join(" ");
  return [...new Set([base, significant].filter((n) => n.length >= 3))];
}

/** "Sam's Club - Credit Card" -> "Sam's Club"; "Capital One" unchanged. */
function issuerVariant(issuerName: string | null | undefined): string | null {
  if (!issuerName) return null;
  const cleaned = issuerName.replace(GENERIC_ISSUER_WORDS, " ").replace(/[-–—]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length >= 3 ? cleaned : null;
}

export const cardPaymentKey = (cardId: string, date: string) => `${cardId}:${date}`;

export type CardPaymentReceipt = { cardId: string; date: string; amountCents: number };

/** Posted CHECKING debits only, supplied by the user-scoped balance-account
 * query. A card-side credit or a paid statement cannot prove checking posted.
 * Explicit allocations win; automatic matches require the amount (exact, or
 * within NEAR_AMOUNT_CENTS, which settles the plan in full), a
 * unique pairing within -3/+14 days, and a name: the card nickname with
 * payment wording, or the card's issuer with payment or transfer wording
 * (banks usually describe the issuer: "Capital One Online Pmt" pays a
 * Quicksilver, "Paypal Inst Xfer" pays PayPal Credit). Ambiguity keeps cash
 * reserved for the user to link, rather than guessing it away.
 */
export function reconcilePlannedCardPayments(
  plans: readonly PlannedCardPayment[],
  drafts: readonly ReconcilableDraft[],
  excludedDraftIds: ReadonlySet<string> = new Set(),
  cardReceipts: readonly CardPaymentReceipt[] = [],
): Map<string, number> {
  const posted = new Map<string, number>();
  const planKeys = new Set(plans.map((p) => cardPaymentKey(p.cardId, p.date)));
  const planCents = new Map(plans.map((p) => [cardPaymentKey(p.cardId, p.date), p.amountCents] as const));
  const explicitlyAssigned = new Set<string>();
  for (const d of drafts) {
    // A split the bank has since invalidated credits nothing (see splitIsValid);
    // the draft still stays out of the heuristic pass below.
    if (!splitIsValid(d)) continue;
    for (const a of d.allocations ?? []) {
      if (a.targetKind !== "card_payment") continue;
      const key = cardPaymentKey(a.targetId, a.targetDate);
      if (!planKeys.has(key)) continue;
      explicitlyAssigned.add(key);
      posted.set(key, (posted.get(key) ?? 0) + a.amountCents);
    }
  }
  // An explicit link that covers the plan to within a dollar settles it.
  for (const key of explicitlyAssigned) {
    const planned = planCents.get(key) ?? 0;
    const linked = posted.get(key) ?? 0;
    if (linked > 0 && Math.abs(planned - linked) <= NEAR_AMOUNT_CENTS) posted.set(key, planned);
  }

  const pairs: Array<{ key: string; draftId: string; cents: number }> = [];
  for (const p of plans) {
    const key = cardPaymentKey(p.cardId, p.date);
    if (explicitlyAssigned.has(key)) continue;
    const names = cardNameVariants(p.cardName);
    const issuer = issuerVariant(p.issuerName);
    for (const d of drafts) {
      if (excludedDraftIds.has(d.id) || d.linkedBillId || d.allocations?.length) continue;
      if (d.amountCents <= 0) continue;
      const exact = d.amountCents === p.amountCents;
      if (!exact && Math.abs(d.amountCents - p.amountCents) > NEAR_AMOUNT_CENTS) continue;
      const gap = daysBetween(p.date, d.date);
      if (gap < -3 || gap > 14) continue;
      const paymentWord = PAYMENT_WORDING.test(d.description);
      const namesIssuer = issuer != null && draftNamesBill(issuer, d);
      const namedPayment =
        (paymentWord && (namesIssuer || names.some((n) => draftNamesBill(n, d)))) ||
        (namesIssuer && TRANSFER_WORDING.test(d.description));
      // A linked card receipt identifies the destination when checking uses
      // an issuer name instead of the user's card nickname. Still require a
      // distinct posted checking debit: the credit leg alone frees no cash.
      // (Receipts pair two bank-reported amounts, so they stay exact.)
      const receipt = exact && cardReceipts.some((r) => r.cardId === p.cardId &&
        r.amountCents === d.amountCents && Math.abs(daysBetween(d.date, r.date)) <= 3);
      if (!namedPayment && !receipt) continue;
      // A near-amount match settles the plan in full (see NEAR_AMOUNT_CENTS).
      pairs.push({ key, draftId: d.id, cents: p.amountCents });
    }
  }
  for (const pair of pairs) {
    if (pairs.filter((p) => p.key === pair.key).length !== 1) continue;
    if (pairs.filter((p) => p.draftId === pair.draftId).length !== 1) continue;
    posted.set(pair.key, pair.cents);
  }
  return posted;
}
