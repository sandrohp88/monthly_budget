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
  amountCents: number;
}): boolean {
  const detailed = (input.detailedCategory ?? "").toUpperCase();
  const primary = (input.primaryCategory ?? "").toUpperCase();
  const desc = (input.description ?? "").toLowerCase();
  if (detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") return true;
  if (primary === "LOAN_PAYMENTS") return true;

  // Below this point every signal is a DESCRIPTION keyword — never bare
  // substring matching on its own. A purchase can legitimately contain
  // "autopay" (GEICO *AUTOPAY, an insurance premium) or "payment" (BALANCE
  // TRANSFER PAYMENT TO CHASE, a transfer to somewhere else), so a keyword
  // only counts alongside a non-merchant category (the credit-side payment
  // landing here, tagged LOAN_DISBURSEMENTS / TRANSFER_IN / TRANSFER_OUT by
  // some issuers) OR a negative amount with NO category at all. A negative
  // amount with a MERCHANT category is a refund wearing the purchase's own
  // descriptor ('GEICO *AUTOPAY' negated is the premium's refund, not a card
  // payment) — it must stay `expense` or it vanishes from the credits view
  // and can even settle a statement by magnitude. This still keeps "Payment
  // Thank You" working for the real ****9873 shape (LOAN_DISBURSEMENTS,
  // negative).
  const hasPaymentKeyword =
    desc.includes("payment thank you") ||
    desc.includes("autopay") ||
    desc.includes("online payment") ||
    desc.includes("bill pay");
  if (!hasPaymentKeyword) return false;

  const isNonMerchantCategory =
    primary === "LOAN_DISBURSEMENTS" || primary === "TRANSFER_IN" || primary === "TRANSFER_OUT";
  if (isNonMerchantCategory) return true;
  return input.amountCents < 0 && primary === "";
}

/**
 * A reversal/return of a prior payment, not a new payment settling a
 * statement. Issuers often tag these with the same payment-like
 * category/description as a real payment, so classification still treats
 * them as `card_payment` (not spend) — but reconciliation must never let one
 * clear a statement. Blocking here only narrows matching (the statement stays
 * visibly open — recoverable), while a miss lets money that moved the wrong
 * way mark a statement paid (silent and irreversible via the promo edge), so
 * the list leans broad and covers the common bounce vocabulary. "nsf"/"rtn"
 * match on word boundaries only — "tra-NSF-er" would otherwise flag every
 * transfer-worded payment.
 */
export function looksLikeReversal(
  description?: string | null,
  originalDescription?: string | null,
): boolean {
  const text = `${description ?? ""} ${originalDescription ?? ""}`.toLowerCase();
  return (
    text.includes("revers") ||
    text.includes("return") ||
    text.includes("redemption") ||
    text.includes("refund") ||
    text.includes("reject") ||
    text.includes("chargeback") ||
    text.includes("dishonor") ||
    text.includes("insufficient") ||
    /\bnsf\b/.test(text) ||
    /\brtn\b/.test(text)
  );
}

/**
 * Classify a synced transaction. A payment toward a linked credit card is
 * `card_payment` (not spend): the cash leaving the source account already
 * covers it. Such a payment posts on the CREDIT account, reducing the balance —
 * so it arrives as a NEGATIVE amount for most issuers and positive for PayPal.
 * We key on the payment-like category/description, not the sign (reconciliation
 * uses the magnitude). Purchases (merchant categories) and refunds stay
 * `expense`.
 *
 * `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` is Plaid's own detailed category for
 * exactly this transaction shape — trustworthy on ANY credit account, not
 * just ones the user has linked to a manual card (an unlinked card's payment
 * still shouldn't count as spend, it just won't be reconciled against a
 * statement — reconciliation is the one step that requires the link). Every
 * other signal (bare LOAN_PAYMENTS, the description-keyword fallbacks) is
 * restricted to accounts linked to one of the user's cards so an unrelated
 * credit account's payments aren't miscounted.
 */
export function classifyDraftKind(input: ClassifyDraftKindInput): PlaidTransactionDraftKind {
  if (input.accountType !== "credit") return "expense";
  if ((input.detailedCategory ?? "").toUpperCase() === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") {
    return "card_payment";
  }
  if (input.accountIsLinkedToCard && looksLikeCardPayment(input)) return "card_payment";
  return "expense";
}
