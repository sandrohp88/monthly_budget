import { describe, expect, it } from "vitest";
import { projectCardPayments, type StatementWithCardName } from "./card-payments";
import type {
  CreditCardPaymentOverrideRow,
  CreditCardPromoRow,
  CreditCardRow,
} from "./db/schema";

function card(over: Partial<CreditCardRow> = {}): CreditCardRow {
  return {
    id: "c1",
    userId: "u1",
    name: "Card",
    statementDay: 15,
    statementCycleMode: "calendar_day",
    statementCycleAnchorDate: null,
    statementCycleIntervalDays: 31,
    dueDay: 10,
    currentBalanceCents: null,
    autoPay: false,
    notes: null,
    isActive: true,
    plaidAccountId: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function stmt(over: Partial<StatementWithCardName> = {}): StatementWithCardName {
  return {
    id: "s1",
    cardId: "c1",
    cardName: "Card",
    statementDate: "2026-05-15",
    dueDate: "2026-06-10",
    statementBalanceCents: 200_00,
    minimumPaymentCents: null,
    paidAmountCents: null,
    paidDate: null,
    notes: null,
    createdAt: 0,
    ...over,
  };
}

function promo(over: Partial<CreditCardPromoRow> = {}): CreditCardPromoRow {
  return {
    id: "p1",
    userId: "u1",
    cardId: "c1",
    description: "Promo",
    originalAmountCents: 500_00,
    remainingAmountCents: 500_00,
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    monthlyPaymentCents: 50_00,
    notes: null,
    isActive: true,
    authoritativeSource: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function override(over: Partial<CreditCardPaymentOverrideRow> = {}): CreditCardPaymentOverrideRow {
  return {
    id: "o1",
    userId: "u1",
    cardId: "c1",
    dueDate: "2026-06-10",
    amountCents: 300_00,
    notes: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

const EMPTY = {
  today: "2026-05-04",
  endDate: "2026-08-01",
  activeCards: [] as CreditCardRow[],
  statements: [] as StatementWithCardName[],
  promos: [] as CreditCardPromoRow[],
  promoPayments: [],
  variableBills: [],
  plaidAccounts: [] as Array<{ id: string; balanceCents: number | null }>,
  cardPaymentOverrides: [] as CreditCardPaymentOverrideRow[],
};

describe("projectCardPayments", () => {
  it("projects an unpaid recorded statement as a payment on its due date", () => {
    const r = projectCardPayments({ ...EMPTY, activeCards: [card()], statements: [stmt()] });
    const cc = r.extras.filter((e) => e.sourceId === "c1");
    expect(cc).toHaveLength(1);
    expect(cc[0]).toMatchObject({
      date: "2026-06-10",
      description: "Card payment",
      amountCents: 200_00,
      originalAmountCents: 200_00,
      sourceType: "creditCardPayment",
    });
  });

  it("a per-cycle override REPLACES the statement amount (and suppresses a planned payment there)", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt()],
      cardPaymentOverrides: [override({ dueDate: "2026-06-10", amountCents: 300_00 })],
    });
    const cc = r.extras.filter((e) => e.sourceId === "c1");
    expect(cc).toHaveLength(1);
    expect(cc[0]).toMatchObject({ amountCents: 300_00, originalAmountCents: 200_00 });
    expect(r.extras.some((e) => e.description === "Card planned payment")).toBe(false);
  });

  it("a planned-payment override fires on a date no other source claims", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt({ dueDate: "2026-06-10" })],
      cardPaymentOverrides: [override({ dueDate: "2026-07-10", amountCents: 150_00 })],
    });
    const planned = r.extras.find((e) => e.description === "Card planned payment");
    expect(planned).toMatchObject({ date: "2026-07-10", amountCents: 150_00, originalAmountCents: 0 });
  });

  it("estimates the open cycle for a card with a live balance and no statement", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ currentBalanceCents: 300_00 })],
    });
    const est = r.extras.find((e) => e.description === "Card next payment (est)");
    // today 2026-05-04 → next close 2026-05-15 → due 2026-06-10.
    expect(est).toMatchObject({ date: "2026-06-10", amountCents: 300_00 });
  });

  it("suppresses the open-cycle estimate when a recorded statement covers that due date", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ currentBalanceCents: 300_00 })],
      statements: [stmt({ statementBalanceCents: 200_00, dueDate: "2026-06-10" })],
    });
    expect(r.extras.some((e) => e.description === "Card next payment (est)")).toBe(false);
    const cc = r.extras.filter((e) => e.sourceId === "c1");
    expect(cc).toHaveLength(1);
    expect(cc[0]?.amountCents).toBe(200_00);
  });

  it("records promo drift when promo principal exceeds the live-balance headroom", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ plaidAccountId: "acct1" })],
      plaidAccounts: [{ id: "acct1", balanceCents: 100_00 }],
      promos: [promo({ remainingAmountCents: 500_00 })],
    });
    // headroom 100_00, promo capped to 100_00 → drift 400_00; open cycle nets to 0.
    expect(r.promoDriftByCard["c1"]).toBe(400_00);
    expect(r.extras.some((e) => e.description === "Card next payment (est)")).toBe(false);
  });

  it("merges multiple sources on the same due date into one payment", () => {
    // Card balance $500, promo $300 remaining. On the next due date (2026-06-10)
    // the open-cycle estimate ($500 − $300 promo = $200) and the promo's first
    // chunk ($50) both land → one merged $250 payment, not two rows.
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ currentBalanceCents: 500_00 })],
      promos: [promo({ remainingAmountCents: 300_00, monthlyPaymentCents: 50_00 })],
    });
    // No two card events ever share a due date.
    const dates = r.extras.map((e) => e.date);
    expect(new Set(dates).size).toBe(dates.length);
    const merged = r.extras.find((e) => e.date === "2026-06-10");
    expect(merged?.amountCents).toBe(250_00);
    expect(merged?.description).toBe("Card payment (est. spend + promo)");
    // Summed metadata.
    expect(merged?.paymentDueCents).toBe(250_00);
  });

  it("leaves a lone source on a date byte-identical (no merge relabeling)", () => {
    const r = projectCardPayments({ ...EMPTY, activeCards: [card()], statements: [stmt()] });
    const cc = r.extras.find((e) => e.date === "2026-06-10");
    // Single source → original label, not "Card payment (statement)".
    expect(cc?.description).toBe("Card payment");
  });

  it("orders sources: statements, then open-cycle estimate, then promo", () => {
    // Statement due 2026-06-10; balance high enough that the open cycle nets a
    // positive estimate on a later, statement-free due date; a promo chunk too.
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ currentBalanceCents: 900_00 })],
      statements: [stmt({ statementBalanceCents: 200_00, dueDate: "2026-06-10" })],
      promos: [promo({ remainingAmountCents: 300_00, monthlyPaymentCents: 50_00 })],
    });
    const labels = r.extras.map((e) => e.description);
    const cc = labels.findIndex((l) => l === "Card payment");
    const est = labels.findIndex((l) => l.includes("next payment (est)"));
    const pr = labels.findIndex((l) => l.startsWith("Card promo"));
    expect(cc).toBeGreaterThanOrEqual(0);
    expect(pr).toBeGreaterThanOrEqual(0);
    // Statements always precede estimate and promo in the returned order.
    expect(cc).toBeLessThan(pr);
    if (est >= 0) expect(cc).toBeLessThan(est);
  });
});
