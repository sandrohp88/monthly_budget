import { describe, expect, it } from "vitest";
import { parsePayPalPromoList, planPromoReconcile } from "./paypal-promo-list";

describe("parsePayPalPromoList", () => {
  it("parses PayPal's stacked promo blocks", () => {
    const text = `
Whisker City
$391.02
No interest if paid in full by Sep 21, 2026

Temu.com
Remaining balance
$112.45
No interest if paid in full by August 14, 2026
`;
    expect(parsePayPalPromoList(text)).toEqual([
      { description: "Whisker City", remainingCents: 391_02, endDate: "2026-09-21" },
      { description: "Temu.com", remainingCents: 112_45, endDate: "2026-08-14" },
    ]);
  });

  it("parses single-line table rows with numeric dates", () => {
    const text = "Light Elegance  $1,275.46  expires 08/25/2026";
    expect(parsePayPalPromoList(text)).toEqual([
      { description: "Light Elegance expires", remainingCents: 1_275_46, endDate: "2026-08-25" },
    ]);
  });

  it("parses stacked blocks without blank separators", () => {
    const text = `Store One
$200.00
by 07/26/2026
Store Two
$150.00
by 06/26/2026`;
    expect(parsePayPalPromoList(text)).toEqual([
      { description: "Store One", remainingCents: 200_00, endDate: "2026-07-26" },
      { description: "Store Two", remainingCents: 150_00, endDate: "2026-06-26" },
    ]);
  });

  it("drops blocks that never get an amount or date (no phantom rows)", () => {
    const text = `
Special financing offers
Learn more about promotional purchases

Muukal
$88.10
No interest if paid in full by Oct 2, 2026
`;
    expect(parsePayPalPromoList(text)).toEqual([
      { description: "Muukal", remainingCents: 88_10, endDate: "2026-10-02" },
    ]);
  });
});

describe("planPromoReconcile", () => {
  const promos = [
    { id: "p1", description: "Temu", remainingAmountCents: 250_92, endDate: "2026-08-14", isActive: true },
    { id: "p2", description: "Whisker City", remainingAmountCents: 391_02, endDate: "2026-09-21", isActive: true },
    { id: "p3", description: "Old Paid Off", remainingAmountCents: 0, endDate: "2026-01-01", isActive: false },
  ];

  it("matches by normalized equality and unique substring; unmatched rows create; missing promos archive", () => {
    const plan = planPromoReconcile(promos, [
      { description: "Temu.com", remainingCents: 112_45, endDate: "2026-08-14" },
      { description: "Brand New Store", remainingCents: 55_00, endDate: "2026-12-01" },
    ]);
    expect(plan.updates).toEqual([
      { promoId: "p1", row: { description: "Temu.com", remainingCents: 112_45, endDate: "2026-08-14" } },
    ]);
    expect(plan.creates).toEqual([
      { description: "Brand New Store", remainingCents: 55_00, endDate: "2026-12-01" },
    ]);
    // Whisker City is active but absent from the pasted list → archive.
    // The inactive promo is never touched.
    expect(plan.archives).toEqual([{ promoId: "p2", description: "Whisker City" }]);
  });

  it("routes ambiguous matches to creates instead of guessing", () => {
    const twins = [
      { id: "a", description: "Store", remainingAmountCents: 1, endDate: "2026-01-01", isActive: true },
      { id: "b", description: "Store 2", remainingAmountCents: 1, endDate: "2026-01-01", isActive: true },
    ];
    const plan = planPromoReconcile(twins, [
      { description: "Stor", remainingCents: 10_00, endDate: "2026-06-01" },
    ]);
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toHaveLength(1);
    expect(plan.archives).toHaveLength(2);
  });
});
