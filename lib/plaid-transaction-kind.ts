export type PlaidTransactionDraftKind = "expense" | "card_payment";

export type ClassifyDraftKindInput = {
  amountCents: number;
  accountType: string | null | undefined;
  accountIsLinkedToCard: boolean;
  primaryCategory?: string | null;
  detailedCategory?: string | null;
  description?: string | null;
};

function hasText(value: string | null | undefined, needle: string): boolean {
  return (value ?? "").toLowerCase().includes(needle);
}

export function classifyDraftKind(input: ClassifyDraftKindInput): PlaidTransactionDraftKind {
  if (input.amountCents <= 0) return "expense";
  if (input.accountType !== "credit") return "expense";

  const detailed = input.detailedCategory?.toUpperCase() ?? "";
  const primary = input.primaryCategory?.toUpperCase() ?? "";

  if (detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") return "card_payment";

  // Detailed category isn't always present (older drafts, modified-only payloads).
  // Fall back to primary LOAN_PAYMENTS on a credit account that the user has linked
  // to one of their cards — that's specific enough to call it a card payment.
  if (input.accountIsLinkedToCard && primary === "LOAN_PAYMENTS") return "card_payment";

  // PayPal Credit reports its payments as primary=LOAN_PAYMENTS with name
  // "PayPal Credit Card" (no detailed category in some response shapes).
  if (
    input.accountIsLinkedToCard &&
    hasText(input.description, "paypal credit") &&
    primary === "LOAN_PAYMENTS"
  ) {
    return "card_payment";
  }

  return "expense";
}
