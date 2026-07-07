/**
 * Minimum purchase for PayPal Credit special financing to auto-seed a promo
 * row. Purchases must be STRICTLY ABOVE this amount.
 *
 * PayPal's published standard offer is "No Interest if paid in full in
 * 6 months on purchases of $149+", but the offer is account-specific — this
 * account's current terms apply to purchases over $170. Keep this matched to
 * the terms shown in PayPal's own promo UI: too low and sub-threshold
 * purchases seed phantom promos (the recurring PayPal drift problem); too
 * high and real promos are missed and must be added manually.
 *
 * Only auto-seeding uses this; manually-entered promos and rows locked via
 * `authoritativeSource` are unaffected. Shared with
 * `isSpecialFinancingCandidate` in lib/plaid-promo-parser.ts — change it here,
 * both sides follow.
 */
export const PAYPAL_SPECIAL_FINANCING_THRESHOLD_CENTS = 170_00;
export const PAYPAL_SPECIAL_FINANCING_MONTHS = 6;

export type PayPalFinancingDraft = {
  id: string;
  accountId: string;
  date: string;
  description: string;
  merchantName: string | null;
  amountCents: number;
  plaidCategory: string | null;
  linkedPromoId: string | null;
};

export type PayPalFinancingPurchase = PayPalFinancingDraft & {
  endDate: string;
};

export type PayPalFinancingPayment = PayPalFinancingDraft;

export type PayPalPromoBalanceInput = {
  id: string;
  date: string;
  originalAmountCents: number;
};

export function addMonthsClampedIso(iso: string, months: number): string {
  const parts = iso.split("-").map(Number);
  const year = parts[0] ?? 1970;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

import { isPaymentLikeCategory } from "./plaid-helpers";

function hasText(value: string | null | undefined, needle: string): boolean {
  return (value ?? "").toLowerCase().includes(needle);
}

export function isPayPalWalletAccount(input: {
  name: string;
  type: string;
  subtype: string | null;
}): boolean {
  return (
    input.type === "depository" &&
    input.subtype === "paypal" &&
    hasText(input.name, "paypal")
  );
}

export function isPayPalCreditAccount(input: {
  name: string;
  type: string;
  subtype: string | null;
}): boolean {
  return (
    input.type === "credit" &&
    input.subtype === "paypal" &&
    hasText(input.name, "paypal credit")
  );
}

export function isPayPalSpecialFinancingPurchase(
  draft: Pick<PayPalFinancingDraft, "amountCents" | "plaidCategory">,
): boolean {
  return (
    draft.amountCents > PAYPAL_SPECIAL_FINANCING_THRESHOLD_CENTS &&
    isPayPalWalletPurchase(draft)
  );
}

export function isPayPalWalletPurchase(
  draft: Pick<PayPalFinancingDraft, "amountCents" | "plaidCategory">,
): boolean {
  return draft.amountCents > 0 && !isPaymentLikeCategory(draft.plaidCategory);
}

export function isPayPalCreditPayment(
  draft: Pick<PayPalFinancingDraft, "amountCents" | "plaidCategory" | "description">,
): boolean {
  return (
    draft.amountCents > 0 &&
    isPaymentLikeCategory(draft.plaidCategory) &&
    hasText(draft.description, "paypal credit")
  );
}

export function toPayPalFinancingPurchase(
  draft: PayPalFinancingDraft,
): PayPalFinancingPurchase | null {
  if (!isPayPalSpecialFinancingPurchase(draft)) return null;
  return {
    ...draft,
    endDate: addMonthsClampedIso(draft.date, PAYPAL_SPECIAL_FINANCING_MONTHS),
  };
}

export function allocatePayPalPaymentsFifo(
  purchases: ReadonlyArray<PayPalPromoBalanceInput>,
  payments: ReadonlyArray<{ date: string; amountCents: number }>,
): Map<string, number> {
  const remaining = new Map<string, number>();
  const openQueue: string[] = [];
  const purchaseById = new Map<string, PayPalPromoBalanceInput>();

  const events = [
    ...purchases.map((purchase) => ({ type: "purchase" as const, date: purchase.date, purchase })),
    ...payments.map((payment) => ({ type: "payment" as const, date: payment.date, payment })),
  ].sort((a, b) => {
    const byDate = a.date.localeCompare(b.date);
    if (byDate !== 0) return byDate;
    if (a.type === b.type) return 0;
    return a.type === "purchase" ? -1 : 1;
  });

  for (const event of events) {
    if (event.type === "purchase") {
      purchaseById.set(event.purchase.id, event.purchase);
      remaining.set(event.purchase.id, event.purchase.originalAmountCents);
      openQueue.push(event.purchase.id);
      continue;
    }

    let unapplied = event.payment.amountCents;
    while (unapplied > 0 && openQueue.length > 0) {
      const id = openQueue[0]!;
      const current = remaining.get(id) ?? 0;
      if (current <= 0) {
        openQueue.shift();
        continue;
      }
      const applied = Math.min(current, unapplied);
      const next = current - applied;
      remaining.set(id, next);
      unapplied -= applied;
      if (next === 0) openQueue.shift();
    }
  }

  for (const purchase of purchases) {
    if (!purchaseById.has(purchase.id)) {
      remaining.set(purchase.id, purchase.originalAmountCents);
    }
  }
  return remaining;
}
