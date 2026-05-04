const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const PROMO_SIGNAL =
  /promo|promotion|promotional|deferred|interest|no interest|avoid interest|paid in full|pay in full/;

type StringRecord = Record<string, unknown>;

function iso(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

function normalizeYear(year: number): number {
  return year < 100 ? 2000 + year : year;
}

function pushText(out: string[], value: unknown): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) pushText(out, item);
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as StringRecord)) pushText(out, nested);
  }
}

/**
 * Plaid's Transaction object contains useful text beyond the three fields we
 * store on a draft. Inspect the raw response at sync time so issuer-specific
 * promo clues in nested fields (payment_meta, counterparties, category, etc.)
 * can still trigger a promo without persisting the whole Plaid payload.
 */
export function plaidTransactionPromoTexts(transaction: unknown): string[] {
  const txn = transaction as StringRecord | null;
  if (!txn || typeof txn !== "object") return [];

  const texts: string[] = [];
  const fields = [
    "name",
    "original_description",
    "merchant_name",
    "website",
    "check_number",
    "transaction_code",
    "category_id",
    "iso_currency_code",
    "unofficial_currency_code",
    "payment_channel",
  ];
  for (const field of fields) pushText(texts, txn[field]);
  pushText(texts, txn.category);
  pushText(texts, txn.personal_finance_category);
  pushText(texts, txn.payment_meta);
  pushText(texts, txn.counterparties);
  pushText(texts, txn.location);

  return [...new Set(texts)];
}

export function detectPromoPayoffDate(texts: ReadonlyArray<string | null | undefined>): string | null {
  const text = texts.filter(Boolean).join(" | ");
  if (!text) return null;

  const lowered = text.toLowerCase();
  const hasPromoSignal = PROMO_SIGNAL.test(lowered);
  if (!hasPromoSignal) return null;

  const numeric = lowered.match(
    /(?:by|until|through|before|exp(?:ires|iration)?(?: date)?|deferred interest date|pay(?:ment)? due)\D{0,24}(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/,
  );
  if (numeric) {
    return iso(
      normalizeYear(Number(numeric[3])),
      Number(numeric[1]),
      Number(numeric[2]),
    );
  }

  const named = lowered.match(
    /(?:by|until|through|before|exp(?:ires|iration)?(?: date)?|deferred interest date|pay(?:ment)? due)\D{0,24}(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{2,4})/,
  );
  if (named) {
    const monthName = named[1];
    if (!monthName) return null;
    const month = MONTHS[monthName];
    if (!month) return null;
    return iso(normalizeYear(Number(named[3])), month, Number(named[2]));
  }

  return null;
}

function includesAny(value: string | null | undefined, needles: string[]): boolean {
  const haystack = value?.toLowerCase() ?? "";
  return needles.some((needle) => haystack.includes(needle));
}

function isPaymentLikeCategory(category: string | null | undefined): boolean {
  const value = category?.toLowerCase() ?? "";
  return (
    value.includes("loan_payments") ||
    value.includes("loan payments") ||
    value.includes("transfer") ||
    value.includes("payment")
  );
}

export type PromoCandidateInput = {
  amountCents: number;
  linkedCreditCardId: string | null;
  linkedPromoId: string | null;
  promoPayoffDate: string | null;
  accountName?: string | null;
  accountSubtype?: string | null;
  linkedCreditCardName?: string | null;
  description?: string | null;
  originalDescription?: string | null;
  merchantName?: string | null;
  plaidCategory?: string | null;
};

export function isSpecialFinancingCandidate(txn: PromoCandidateInput): boolean {
  if (txn.amountCents <= 0 || !txn.linkedCreditCardId || txn.linkedPromoId) return false;
  if (isPaymentLikeCategory(txn.plaidCategory)) return false;
  if (txn.promoPayoffDate) return true;

  const isPayPalCredit = [
    txn.accountName,
    txn.accountSubtype,
    txn.linkedCreditCardName,
    txn.description,
    txn.originalDescription,
    txn.merchantName,
  ].some((text) => includesAny(text, ["paypal credit"]));

  // PayPal's real transaction feed uses the wallet account for purchases and
  // the credit account for payments. Treat purchases over $150 as review
  // candidates when a paired PayPal Credit card exists; sync reconciles these
  // rows idempotently with FIFO payment allocation.
  return isPayPalCredit && txn.amountCents > 150_00;
}
