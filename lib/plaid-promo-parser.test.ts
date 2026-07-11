import { describe, expect, it } from "vitest";
import {
  detectPromoPayoffDate,
  isSpecialFinancingCandidate,
  plaidTransactionPromoTexts,
} from "./plaid-promo-parser";
import { PAYPAL_SPECIAL_FINANCING_THRESHOLD_CENTS } from "./paypal-special-financing";

describe("detectPromoPayoffDate", () => {
  it("detects numeric PayPal-style paid-in-full dates", () => {
    expect(
      detectPromoPayoffDate([
        "PAYPAL CREDIT PROMOTION: No Interest if paid in full by 11/04/2026",
      ]),
    ).toBe("2026-11-04");
  });

  it("detects named month payoff dates", () => {
    expect(
      detectPromoPayoffDate([
        "Deferred interest promotion expires May 4, 2026",
      ]),
    ).toBe("2026-05-04");
  });

  it("ignores dates without a promo signal", () => {
    expect(detectPromoPayoffDate(["PAYPAL PURCHASE 05/04/2026"])).toBeNull();
  });

  it("ignores generic statement grace text without a promo signal", () => {
    expect(detectPromoPayoffDate(["0 APR if balance paid in full by 11/04/2026"])).toBeNull();
  });

  it("inspects nested Plaid transaction text for promo payoff dates", () => {
    const texts = plaidTransactionPromoTexts({
      name: "PayPal Credit Card",
      payment_meta: {
        reference_number: "No Interest if paid in full by 10/30/2026",
      },
      counterparties: [
        { name: "PayPal Credit", type: "financial_institution" },
      ],
      personal_finance_category: {
        primary: "LOAN_PAYMENTS",
        detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
      },
    });

    expect(detectPromoPayoffDate(texts)).toBe("2026-10-30");
  });

  it("flags PayPal Credit purchases over the current financing threshold", () => {
    expect(
      isSpecialFinancingCandidate({
        amountCents: PAYPAL_SPECIAL_FINANCING_THRESHOLD_CENTS + 1,
        linkedCreditCardId: "card_1",
        linkedPromoId: null,
        promoPayoffDate: null,
        accountName: "PayPal",
        accountSubtype: "paypal",
        linkedCreditCardName: "PayPal Credit",
        plaidCategory: "GENERAL_MERCHANDISE",
      }),
    ).toBe(true);
  });

  it("does not flag PayPal purchases below the threshold", () => {
    expect(
      isSpecialFinancingCandidate({
        amountCents: PAYPAL_SPECIAL_FINANCING_THRESHOLD_CENTS - 1,
        linkedCreditCardId: "card_1",
        linkedPromoId: null,
        promoPayoffDate: null,
        accountName: "PayPal",
        accountSubtype: "paypal",
        linkedCreditCardName: "PayPal Credit",
        plaidCategory: "GENERAL_MERCHANDISE",
      }),
    ).toBe(false);
  });

  it("does not treat generic PayPal loan payments as promo purchases", () => {
    expect(
      isSpecialFinancingCandidate({
        amountCents: 506_00,
        linkedCreditCardId: "card_1",
        linkedPromoId: null,
        promoPayoffDate: null,
        accountName: "PayPal Credit Card",
        accountSubtype: "paypal",
        linkedCreditCardName: "PayPal Credit",
        description: "PayPal Credit Card",
        plaidCategory: "LOAN_PAYMENTS",
      }),
    ).toBe(false);
  });
});
