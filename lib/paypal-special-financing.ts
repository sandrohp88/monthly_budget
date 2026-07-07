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

export function toPayPalFinancingPurchase(
  draft: PayPalFinancingDraft,
): PayPalFinancingPurchase | null {
  if (!isPayPalSpecialFinancingPurchase(draft)) return null;
  return {
    ...draft,
    endDate: addMonthsClampedIso(draft.date, PAYPAL_SPECIAL_FINANCING_MONTHS),
  };
}

// NOTE: the payment-to-purchase FIFO allocator that used to live here was
// removed on purpose. Plaid's PayPal payment rows don't expose the issuer's
// targeted promo allocation, so FIFO-derived remaining balances were
// systematically wrong. Promo amounts now change only via the unpaid→paid
// statement decrement edge or the paste-the-PayPal-promo-list reconcile flow.
