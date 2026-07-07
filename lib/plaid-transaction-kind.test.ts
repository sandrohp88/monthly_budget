import { describe, expect, it } from "vitest";
import { classifyDraftKind } from "./plaid-transaction-kind";

describe("classifyDraftKind", () => {
  it("classifies LOAN_PAYMENTS_CREDIT_CARD_PAYMENT on a credit account as card_payment", () => {
    expect(
      classifyDraftKind({
        amountCents: 50600,
        accountType: "credit",
        accountIsLinkedToCard: true,
        primaryCategory: "LOAN_PAYMENTS",
        detailedCategory: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
        description: "PayPal Credit Card",
      }),
    ).toBe("card_payment");
  });

  it("falls back to primary LOAN_PAYMENTS when detailed is missing on a linked credit account", () => {
    expect(
      classifyDraftKind({
        amountCents: 50600,
        accountType: "credit",
        accountIsLinkedToCard: true,
        primaryCategory: "LOAN_PAYMENTS",
        detailedCategory: null,
        description: "PayPal Credit Card",
      }),
    ).toBe("card_payment");
  });

  it("does not classify LOAN_PAYMENTS as card_payment when the account isn't linked to a card", () => {
    expect(
      classifyDraftKind({
        amountCents: 50600,
        accountType: "credit",
        accountIsLinkedToCard: false,
        primaryCategory: "LOAN_PAYMENTS",
        detailedCategory: null,
        description: "PayPal Credit Card",
      }),
    ).toBe("expense");
  });

  it("classifies a negative-amount payment on a linked credit account as card_payment", () => {
    // A real card payment posts on the credit account as money in (negative),
    // reducing the balance. This is the common non-PayPal shape.
    expect(
      classifyDraftKind({
        amountCents: -12000,
        accountType: "credit",
        accountIsLinkedToCard: true,
        primaryCategory: "LOAN_PAYMENTS",
        detailedCategory: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
        description: "PayPal Credit Card",
      }),
    ).toBe("card_payment");
  });

  it("classifies a negative LOAN_DISBURSEMENTS 'Payment Thank You' as card_payment", () => {
    // Some issuers mis-tag the credit-side payment as LOAN_DISBURSEMENTS; the
    // description disambiguates it (the real-world shape on ****9873).
    expect(
      classifyDraftKind({
        amountCents: -21941,
        accountType: "credit",
        accountIsLinkedToCard: true,
        primaryCategory: "LOAN_DISBURSEMENTS",
        detailedCategory: null,
        description: "Payment Thank You - Web",
      }),
    ).toBe("card_payment");
  });

  it("does not classify a refund/return (negative, merchant category) as card_payment", () => {
    expect(
      classifyDraftKind({
        amountCents: -4200,
        accountType: "credit",
        accountIsLinkedToCard: true,
        primaryCategory: "GENERAL_MERCHANDISE",
        detailedCategory: "GENERAL_MERCHANDISE_PET_SUPPLIES",
        description: "Chewy Refund",
      }),
    ).toBe("expense");
  });

  it("does not classify rows on depository accounts as card_payment", () => {
    expect(
      classifyDraftKind({
        amountCents: 50600,
        accountType: "depository",
        accountIsLinkedToCard: false,
        primaryCategory: "TRANSFER_OUT",
        detailedCategory: "TRANSFER_OUT_OTHER_TRANSFER",
        description: "Money Transfer to Great Basin Federal Credit Union",
      }),
    ).toBe("expense");
  });

  it("leaves ordinary purchases as expense", () => {
    expect(
      classifyDraftKind({
        amountCents: 1700,
        accountType: "credit",
        accountIsLinkedToCard: true,
        primaryCategory: "GENERAL_MERCHANDISE",
        detailedCategory: "GENERAL_MERCHANDISE_PET_SUPPLIES",
        description: "Chewy",
      }),
    ).toBe("expense");
  });
});
