import { describe, expect, it } from "vitest";
import {
  addMonthsClampedIso,
  allocatePayPalPaymentsFifo,
  isPayPalCreditPayment,
  isPayPalSpecialFinancingPurchase,
  isPayPalWalletPurchase,
} from "./paypal-special-financing";

describe("PayPal special financing helpers", () => {
  it("uses PayPal's over-$150 threshold for special financing purchases", () => {
    expect(isPayPalSpecialFinancingPurchase({ amountCents: 150_00, plaidCategory: "GENERAL_MERCHANDISE" })).toBe(false);
    expect(isPayPalSpecialFinancingPurchase({ amountCents: 150_01, plaidCategory: "GENERAL_MERCHANDISE" })).toBe(true);
    expect(isPayPalSpecialFinancingPurchase({ amountCents: 506_00, plaidCategory: "LOAN_PAYMENTS" })).toBe(false);
  });

  it("recognizes PayPal wallet purchases below the promo threshold for FIFO allocation", () => {
    expect(isPayPalWalletPurchase({ amountCents: 50_00, plaidCategory: "GENERAL_MERCHANDISE" })).toBe(true);
    expect(isPayPalWalletPurchase({ amountCents: 506_00, plaidCategory: "LOAN_PAYMENTS" })).toBe(false);
  });

  it("recognizes PayPal Credit payment rows from the credit account", () => {
    expect(
      isPayPalCreditPayment({
        amountCents: 506_00,
        plaidCategory: "LOAN_PAYMENTS",
        description: "PayPal Credit Card",
      }),
    ).toBe(true);
    expect(
      isPayPalCreditPayment({
        amountCents: 172_17,
        plaidCategory: "GENERAL_MERCHANDISE",
        description: "Payment to Chewy, Inc.",
      }),
    ).toBe(false);
  });

  it("sets the payoff deadline six months after the purchase date", () => {
    expect(addMonthsClampedIso("2026-02-14", 6)).toBe("2026-08-14");
    expect(addMonthsClampedIso("2026-08-31", 6)).toBe("2027-02-28");
  });

  it("allocates PayPal Credit payments FIFO against purchases already made", () => {
    const balances = allocatePayPalPaymentsFifo(
      [
        { id: "small", date: "2026-02-13", originalAmountCents: 50_00 },
        { id: "feb14", date: "2026-02-14", originalAmountCents: 250_92 },
        { id: "feb25", date: "2026-02-25", originalAmountCents: 275_46 },
        { id: "mar01", date: "2026-03-01", originalAmountCents: 162_09 },
      ],
      [
        { date: "2026-02-09", amountCents: 354_66 },
        { date: "2026-03-04", amountCents: 188_47 },
      ],
    );

    expect(balances.get("small")).toBe(0);
    expect(balances.get("feb14")).toBe(112_45);
    expect(balances.get("feb25")).toBe(275_46);
    expect(balances.get("mar01")).toBe(162_09);
  });
});
