import { describe, expect, it } from "vitest";
import {
  looksLikeChaseFlexPlanList,
  parseChaseFlexPlanList,
  planChaseFlexReconcile,
  type ChaseFlexPlanRow,
} from "./chase-flex-plan-list";
import type { MatchablePromo } from "./paypal-promo-list";

// ── parser: statement-table shape ───────────────────────────────────────────
// Golden input: the QUALIFIED PROMOTIONAL FINANCING table exactly as text
// extraction renders it from the real Prime Visa 07/10/26 statement.
const JULY_TABLE = `Equal Pay Promo $146.75 $73.37 10/07/2026 ---- ---- ---- $24.46
Equal Pay Promo $184.87 $123.23 11/07/2026 ---- ---- ---- $30.82
Equal Pay Promo $106.91 $89.09 12/07/2026 ---- ---- ---- $17.82
Equal Pay Promo $210.32 $210.32 01/07/2027 ---- ---- ---- $35.06`;

describe("parseChaseFlexPlanList — statement table", () => {
  it("parses the real 07/10/26 table: all four plans with totals, remainders, dates, plan payments", () => {
    const rows = parseChaseFlexPlanList(JULY_TABLE);
    expect(rows).toEqual([
      { description: "Equal Pay Promo", originalCents: 146_75, remainingCents: 73_37, endDate: "2026-10-07", monthlyPaymentCents: 24_46 },
      { description: "Equal Pay Promo", originalCents: 184_87, remainingCents: 123_23, endDate: "2026-11-07", monthlyPaymentCents: 30_82 },
      { description: "Equal Pay Promo", originalCents: 106_91, remainingCents: 89_09, endDate: "2026-12-07", monthlyPaymentCents: 17_82 },
      { description: "Equal Pay Promo", originalCents: 210_32, remainingCents: 210_32, endDate: "2027-01-07", monthlyPaymentCents: 35_06 },
    ]);
  });

  it("survives the statement's surrounding boilerplate lines", () => {
    const rows = parseChaseFlexPlanList(
      `QUALIFIED PROMOTIONAL FINANCING
Description Total Qualified Amount Remaining Balance Expiration Date
${JULY_TABLE}
Your  is the annual interest rate on your account.
Purchases 25.74%(v)(d) - 0 -   - 0 -
Equal Pay Promo 0.00% (d) $84.78 - 0 -`,
    );
    // The APR section's "Equal Pay Promo 0.00% (d) $84.78 - 0 -" line has an
    // amount but no date — it must not leak into the rows.
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.endDate)).toEqual([
      "2026-10-07",
      "2026-11-07",
      "2026-12-07",
      "2027-01-07",
    ]);
  });

  it("a fresh plan (remaining == total) parses with both amounts equal", () => {
    const rows = parseChaseFlexPlanList(
      "Equal Pay Promo $210.32 $210.32 01/07/2027 ---- ---- ---- $35.06",
    );
    expect(rows[0]).toMatchObject({ originalCents: 210_32, remainingCents: 210_32 });
  });

  it("drops a min-pay candidate that is not smaller than the remaining balance", () => {
    // Two amounts + a stray copy of the remaining at the end — not a plan payment.
    const rows = parseChaseFlexPlanList("Plan $100.00 $80.00 10/07/2026 $80.00");
    expect(rows[0]).toMatchObject({ remainingCents: 80_00, monthlyPaymentCents: null });
  });

  it("handles thousands separators and 2-digit years", () => {
    const rows = parseChaseFlexPlanList("My Chase Plan $1,229.89 $1,024.91 3/15/27 $102.49");
    expect(rows[0]).toEqual({
      description: "My Chase Plan",
      originalCents: 1229_89,
      remainingCents: 1024_91,
      endDate: "2027-03-15",
      monthlyPaymentCents: 102_49,
    });
  });
});

describe("parseChaseFlexPlanList — multi-line plan cards", () => {
  it("accumulates a chase.com-style block across lines", () => {
    const rows = parseChaseFlexPlanList(`AMAZON MKTPL PURCHASE
$123.23 remaining of $184.87
Plan payment $30.82
Expires 11/07/2026

WHOLE FOODS PLAN
$89.09 remaining of $106.91
Plan payment $17.82
Expires 12/07/2026`);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      description: "AMAZON MKTPL PURCHASE",
      remainingCents: 123_23,
      endDate: "2026-11-07",
    });
    expect(rows[1]).toMatchObject({ description: "WHOLE FOODS PLAN", endDate: "2026-12-07" });
  });

  it("drops an incomplete block instead of guessing", () => {
    const rows = parseChaseFlexPlanList(`SOME PLAN
$50.00 remaining

NEXT PLAN
$60.00 remaining
Expires 10/07/2026`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ remainingCents: 60_00, endDate: "2026-10-07" });
  });

  it("a one-line 'remaining of' card keeps remaining and total straight", () => {
    const rows = parseChaseFlexPlanList("$123.23 remaining of $184.87 expires 11/07/2026");
    expect(rows[0]).toMatchObject({
      remainingCents: 123_23,
      originalCents: 184_87,
      endDate: "2026-11-07",
    });
  });

  it("returns nothing for unrelated text", () => {
    expect(parseChaseFlexPlanList("hello world\nno money here")).toEqual([]);
  });
});

describe("looksLikeChaseFlexPlanList", () => {
  it("detects Equal Pay / statement-table pastes", () => {
    expect(looksLikeChaseFlexPlanList(JULY_TABLE)).toBe(true);
    expect(looksLikeChaseFlexPlanList("My Chase Plan\n$100 of $200\n01/07/2027")).toBe(true);
  });

  it("does not fire on a PayPal-style paste", () => {
    expect(
      looksLikeChaseFlexPlanList(
        "Whisker City\n$391.02\nNo interest if paid in full by Sep 21, 2026",
      ),
    ).toBe(false);
  });
});

// ── matcher ─────────────────────────────────────────────────────────────────

function matchable(over: Partial<MatchablePromo> & { id: string }): MatchablePromo {
  return {
    description: "Equal Pay",
    remainingAmountCents: 100_00,
    endDate: "2026-10-07",
    isActive: true,
    ...over,
  };
}

function row(over: Partial<ChaseFlexPlanRow> = {}): ChaseFlexPlanRow {
  return {
    description: "Equal Pay Promo",
    originalCents: null,
    remainingCents: 100_00,
    endDate: "2026-10-07",
    monthlyPaymentCents: null,
    ...over,
  };
}

describe("planChaseFlexReconcile", () => {
  // The real prod shape: four promos named by their end month, matched against
  // four statement rows that all share one description.
  const prodPromos: MatchablePromo[] = [
    matchable({ id: "oct", description: "Equal Pay — ends Oct 2026", remainingAmountCents: 97_83, endDate: "2026-10-07" }),
    matchable({ id: "nov", description: "Equal Pay — ends Nov 2026", remainingAmountCents: 154_05, endDate: "2026-11-07" }),
    matchable({ id: "dec", description: "Equal Pay — ends Dec 2026", remainingAmountCents: 106_91, endDate: "2026-12-07" }),
    matchable({ id: "jan", description: "Equal Pay — ends Jan 2027", remainingAmountCents: 210_32, endDate: "2027-01-07" }),
  ];

  it("matches every statement row to its promo by expiration date", () => {
    const rows = parseChaseFlexPlanList(JULY_TABLE);
    const plan = planChaseFlexReconcile(prodPromos, rows);
    expect(plan.creates).toEqual([]);
    expect(plan.archives).toEqual([]);
    expect(plan.updates.map((u) => u.promoId)).toEqual(["oct", "nov", "dec", "jan"]);
    // The Oct plan's balance moves to the newer statement's remaining.
    expect(plan.updates[0]!.row.remainingCents).toBe(73_37);
  });

  it("two plans sharing an expiration disambiguate by remaining balance", () => {
    const promos = [
      matchable({ id: "a", remainingAmountCents: 50_00, endDate: "2026-10-07" }),
      matchable({ id: "b", remainingAmountCents: 80_00, endDate: "2026-10-07" }),
    ];
    const plan = planChaseFlexReconcile(promos, [
      row({ remainingCents: 80_00 }),
      row({ remainingCents: 50_00 }),
    ]);
    expect(plan.updates).toEqual([
      { promoId: "b", row: expect.objectContaining({ remainingCents: 80_00 }) },
      { promoId: "a", row: expect.objectContaining({ remainingCents: 50_00 }) },
    ]);
  });

  it("ambiguous rows become creates, never guesses", () => {
    // Same endDate, same remaining on both promos — nothing is unique.
    const promos = [
      matchable({ id: "a", remainingAmountCents: 50_00 }),
      matchable({ id: "b", remainingAmountCents: 50_00 }),
    ];
    const plan = planChaseFlexReconcile(promos, [row({ remainingCents: 50_00 })]);
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toHaveLength(1);
    expect(plan.archives.map((a) => a.promoId).sort()).toEqual(["a", "b"]);
  });

  it("a paid-off plan disappears from the table → archive candidate", () => {
    const plan = planChaseFlexReconcile(prodPromos, [
      row({ remainingCents: 123_23, endDate: "2026-11-07" }),
    ]);
    expect(plan.updates.map((u) => u.promoId)).toEqual(["nov"]);
    expect(plan.archives.map((a) => a.promoId).sort()).toEqual(["dec", "jan", "oct"]);
  });

  it("a brand-new plan with an unseen expiration becomes a create", () => {
    const plan = planChaseFlexReconcile(prodPromos, [
      row({ endDate: "2027-02-07", remainingCents: 300_00 }),
    ]);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]!.endDate).toBe("2027-02-07");
  });

  it("falls back to description matching when dates changed", () => {
    const promos = [matchable({ id: "x", description: "Whisker robot", endDate: "2026-09-07" })];
    const plan = planChaseFlexReconcile(promos, [
      row({ description: "Whisker", endDate: "2026-10-07", remainingCents: 42_00 }),
    ]);
    expect(plan.updates.map((u) => u.promoId)).toEqual(["x"]);
  });

  it("inactive promos never match or archive", () => {
    const promos = [matchable({ id: "gone", isActive: false })];
    const plan = planChaseFlexReconcile(promos, [row()]);
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toHaveLength(1);
    expect(plan.archives).toEqual([]);
  });
});
