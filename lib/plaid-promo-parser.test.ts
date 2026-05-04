import { describe, expect, it } from "vitest";
import { detectPromoPayoffDate } from "./plaid-promo-parser";

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
});
