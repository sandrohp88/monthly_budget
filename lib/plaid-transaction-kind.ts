export type PlaidTransactionDraftKind = "expense" | "card_payment";

export type ClassifyDraftKindInput = {
  amountCents: number;
  accountType: string | null | undefined;
  accountIsLinkedToCard: boolean;
  primaryCategory?: string | null;
  detailedCategory?: string | null;
  description?: string | null;
};

/**
 * Payment-like signal, independent of account/sign. A card payment posts on the
 * credit account with a loan/payment category or an unmistakable payment
 * description ("Payment Thank You", autopay, etc.). Used both to classify and
 * to re-evaluate already-stored drafts (which only keep the PRIMARY category,
 * so this must work without the detailed one).
 */
export function looksLikeCardPayment(input: {
  primaryCategory?: string | null;
  detailedCategory?: string | null;
  description?: string | null;
}): boolean {
  const detailed = (input.detailedCategory ?? "").toUpperCase();
  const primary = (input.primaryCategory ?? "").toUpperCase();
  const desc = (input.description ?? "").toLowerCase();
  if (detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") return true;
  if (primary === "LOAN_PAYMENTS") return true;
  // Some issuers mis-tag the credit-side payment as LOAN_DISBURSEMENTS; the
  // "payment" in the description disambiguates it from a real disbursement.
  if (primary === "LOAN_DISBURSEMENTS" && desc.includes("payment")) return true;
  // Fallback: an unmistakable payment description regardless of category.
  return (
    desc.includes("payment thank you") ||
    desc.includes("autopay") ||
    desc.includes("online payment") ||
    desc.includes("bill pay")
  );
}

/**
 * Classify a synced transaction. A payment toward a linked credit card is
 * `card_payment` (not spend): the cash leaving the source account already
 * covers it. Such a payment posts on the CREDIT account, reducing the balance —
 * so it arrives as a NEGATIVE amount for most issuers and positive for PayPal.
 * We key on the payment-like category/description, not the sign (reconciliation
 * uses the magnitude). Purchases (merchant categories) and refunds stay
 * `expense`. Restricted to accounts linked to one of the user's cards so an
 * unrelated credit account's payments aren't miscounted.
 */
export function classifyDraftKind(input: ClassifyDraftKindInput): PlaidTransactionDraftKind {
  if (input.accountType === "credit" && input.accountIsLinkedToCard && looksLikeCardPayment(input)) {
    return "card_payment";
  }
  return "expense";
}
