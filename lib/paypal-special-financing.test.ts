import { describe, expect, it } from "vitest";
import {
  addMonthsClampedIso,
  isPayPalSpecialFinancingPurchase,
  isPayPalWalletPurchase,
  PAYPAL_SPECIAL_FINANCING_THRESHOLD_CENTS,
} from "./paypal-special-financing";

describe("PayPal special financing helpers", () => {
  it("only flags purchases strictly above the account's financing threshold", () => {
    const threshold = PAYPAL_SPECIAL_FINANCING_THRESHOLD_CENTS;
    expect(isPayPalSpecialFinancingPurchase({ amountCents: threshold, plaidCategory: "GENERAL_MERCHANDISE" })).toBe(false);
    expect(isPayPalSpecialFinancingPurchase({ amountCents: threshold + 1, plaidCategory: "GENERAL_MERCHANDISE" })).toBe(true);
    expect(isPayPalSpecialFinancingPurchase({ amountCents: 506_00, plaidCategory: "LOAN_PAYMENTS" })).toBe(false);
  });

  it("recognizes PayPal wallet purchases vs payment-like rows", () => {
    expect(isPayPalWalletPurchase({ amountCents: 50_00, plaidCategory: "GENERAL_MERCHANDISE" })).toBe(true);
    expect(isPayPalWalletPurchase({ amountCents: 506_00, plaidCategory: "LOAN_PAYMENTS" })).toBe(false);
  });

  it("sets the payoff deadline six months after the purchase date", () => {
    expect(addMonthsClampedIso("2026-02-14", 6)).toBe("2026-08-14");
    expect(addMonthsClampedIso("2026-08-31", 6)).toBe("2027-02-28");
  });
});
