import { describe, expect, it } from "vitest";
import {
  cardPaymentMoveError,
  projectCardPayments,
  type StatementWithCardName,
} from "./card-payments";
import type {
  CreditCardPaymentOverrideRow,
  CreditCardPromoPaymentRow,
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
    gracePeriodDays: 14,
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
    dueDateUserOverride: false,
    statementBalanceCents: 200_00,
    minimumPaymentCents: null,
    paidAmountCents: null,
    paidDate: null,
    notes: null,
    settledByDraftId: null,
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

describe("scheduled paydowns (pays-down overrides)", () => {
  it("a pending paydown reduces the statement slot and debits its own date", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt({ statementBalanceCents: 200_00, dueDate: "2026-06-10" })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-20", amountCents: 80_00, notes: "pays-down:2026-06-10" }),
      ],
    });
    const slot = r.extras.find((e) => e.date === "2026-06-10");
    expect(slot).toMatchObject({ amountCents: 120_00, paymentDueCents: 120_00 });
    const planned = r.extras.find((e) => e.date === "2026-05-20");
    expect(planned).toMatchObject({
      amountCents: 80_00,
      description: "Card planned payment",
      paydownTargetDate: "2026-06-10",
    });
    // Cash conservation: total out equals the statement balance.
    const total = r.extras.reduce((s, e) => s + e.amountCents, 0);
    expect(total).toBe(200_00);
  });

  it("a paydown covering the whole statement zeroes the due-date slot", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt({ statementBalanceCents: 200_00, dueDate: "2026-06-10" })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-20", amountCents: 200_00, notes: "pays-down:2026-06-10" }),
      ],
    });
    const slot = r.extras.find((e) => e.date === "2026-06-10");
    expect(slot).toMatchObject({ amountCents: 0, paymentDueCents: 0 });
    const total = r.extras.reduce((s, e) => s + e.amountCents, 0);
    expect(total).toBe(200_00);
  });

  it("a PAST-dated paydown no longer reduces the target slot", () => {
    // today in EMPTY is 2026-05-04; the paydown is dated before that. Reality
    // (posted payments, statement paid amounts) carries the effect instead.
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt({ statementBalanceCents: 200_00, dueDate: "2026-06-10" })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-01", amountCents: 80_00, notes: "pays-down:2026-06-10" }),
      ],
    });
    const slot = r.extras.find((e) => e.date === "2026-06-10");
    expect(slot).toMatchObject({ amountCents: 200_00, paymentDueCents: 200_00 });
  });

  it("consumes a paydown once across colliding generators on the same due date", () => {
    // Live balance 300 with promo remaining 100 → open-cycle estimate 200 on
    // 2026-06-10; the promo's 50/mo chunk lands on the same date. A 220
    // paydown must reduce the combined 250, never fire once per generator.
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ currentBalanceCents: 300_00 })],
      promos: [promo({ remainingAmountCents: 100_00, monthlyPaymentCents: 50_00 })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-20", amountCents: 220_00, notes: "pays-down:2026-06-10" }),
      ],
    });
    const onDue = r.extras.filter((e) => e.date === "2026-06-10");
    expect(onDue.reduce((s, e) => s + e.amountCents, 0)).toBe(30_00);
    // Cash conservation: everything still totals the live balance.
    const total = r.extras.reduce((s, e) => s + e.amountCents, 0);
    expect(total).toBe(300_00);
  });

  it("a paydown with no matching slot is a plain extra planned payment", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-20", amountCents: 50_00, notes: "pays-down:2026-06-10" }),
      ],
    });
    expect(r.extras).toHaveLength(1);
    expect(r.extras[0]).toMatchObject({
      date: "2026-05-20",
      amountCents: 50_00,
      paydownTargetDate: "2026-06-10",
    });
  });

  it("a paydown scheduled ON the due date merges into one row with unchanged total", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt({ statementBalanceCents: 200_00, dueDate: "2026-06-10" })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-06-10", amountCents: 80_00, notes: "pays-down:2026-06-10" }),
      ],
    });
    const onDue = r.extras.filter((e) => e.date === "2026-06-10");
    expect(onDue).toHaveLength(1);
    expect(onDue[0]!.amountCents).toBe(200_00);
    expect(onDue[0]!.description).toBe("Card payment (statement + planned)");
  });

  it("does not treat a pays-down override as a slot replacement", () => {
    // The paydown targets a DIFFERENT date than its own; the statement slot on
    // its own date must not be replaced by the paydown amount.
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [
        stmt({ id: "s1", statementBalanceCents: 200_00, dueDate: "2026-06-10" }),
        stmt({
          id: "s2",
          statementDate: "2026-06-15",
          statementBalanceCents: 400_00,
          dueDate: "2026-07-10",
        }),
      ],
      cardPaymentOverrides: [
        override({ dueDate: "2026-06-10", amountCents: 80_00, notes: "pays-down:2026-07-10" }),
      ],
    });
    // June slot: full statement + the paydown extra, merged.
    const june = r.extras.filter((e) => e.date === "2026-06-10");
    expect(june.reduce((s, e) => s + e.amountCents, 0)).toBe(280_00);
    // July slot: reduced by the paydown.
    const july = r.extras.find((e) => e.date === "2026-07-10");
    expect(july).toMatchObject({ amountCents: 320_00, paymentDueCents: 320_00 });
  });
});

describe("cardPaymentMoveError", () => {
  const today = "2026-06-01";

  it("rejects moving a payment into the past", () => {
    expect(
      cardPaymentMoveError(
        { fromDate: "2026-06-10", isPaydown: false, paymentDueCents: 200_00 },
        "2026-05-31",
        today,
      ),
    ).toContain("future date");
  });

  it("allows moving a statement due earlier", () => {
    expect(
      cardPaymentMoveError(
        { fromDate: "2026-06-10", isPaydown: false, paymentDueCents: 200_00 },
        "2026-06-05",
        today,
      ),
    ).toBeNull();
  });

  it("rejects moving a statement due after its due date", () => {
    expect(
      cardPaymentMoveError(
        { fromDate: "2026-06-10", isPaydown: false, paymentDueCents: 200_00 },
        "2026-06-11",
        today,
      ),
    ).toContain("after its due date");
  });

  it("uses relatedDate as the deadline for an already-moved payment", () => {
    // Payment was moved from its 2026-06-10 issuer due date to 2026-06-04.
    // Dragging it back out to 2026-06-08 is still on/before the deadline → ok.
    expect(
      cardPaymentMoveError(
        {
          fromDate: "2026-06-04",
          isPaydown: false,
          paymentDueCents: 200_00,
          relatedDate: "2026-06-10",
        },
        "2026-06-08",
        today,
      ),
    ).toBeNull();
    // …but past the original due date is still rejected.
    expect(
      cardPaymentMoveError(
        {
          fromDate: "2026-06-04",
          isPaydown: false,
          paymentDueCents: 200_00,
          relatedDate: "2026-06-10",
        },
        "2026-06-12",
        today,
      ),
    ).toContain("after its due date");
  });

  it("lets a paydown move to any future day", () => {
    expect(
      cardPaymentMoveError(
        { fromDate: "2026-06-02", isPaydown: true, paymentDueCents: 0 },
        "2026-09-30",
        today,
      ),
    ).toBeNull();
  });

  it("lets a plain planned payment (no due) move to any future day", () => {
    expect(
      cardPaymentMoveError(
        { fromDate: "2026-06-02", isPaydown: false, paymentDueCents: 0 },
        "2026-08-15",
        today,
      ),
    ).toBeNull();
  });

  it("treats same-day as a valid (no-op) position", () => {
    expect(
      cardPaymentMoveError(
        { fromDate: "2026-06-10", isPaydown: false, paymentDueCents: 200_00 },
        "2026-06-10",
        today,
      ),
    ).toBeNull();
  });
});

describe("projectCardPayments — over-sized paydown credits the promo balance", () => {
  const cardBase = card({ currentBalanceCents: null, dueDay: 10 });
  const promo1 = promo({
    id: "pr1",
    description: "Promo1",
    remainingAmountCents: 100_00,
    startDate: "2026-01-01",
    endDate: "2026-08-10",
  });
  const promo2 = promo({
    id: "pr2",
    description: "Promo2",
    remainingAmountCents: 100_00,
    startDate: "2026-01-01",
    endDate: "2026-08-10",
  });
  // Manual schedules pin each promo's chunk to a specific due date.
  const promoPayments: CreditCardPromoPaymentRow[] = [
    { id: "ppa", userId: "u1", promoId: "pr1", dueDate: "2026-06-10", amountCents: 100_00, note: null, createdAt: 0, updatedAt: 0 },
    { id: "ppb", userId: "u1", promoId: "pr2", dueDate: "2026-07-10", amountCents: 100_00, note: null, createdAt: 0, updatedAt: 0 },
  ];
  const base = {
    ...EMPTY,
    today: "2026-05-04",
    activeCards: [cardBase],
    promos: [promo1, promo2],
    promoPayments,
  };

  it("credits an over-sized paydown's excess to later promo chunks (total <= balance)", () => {
    const r = projectCardPayments({
      ...base,
      cardPaymentOverrides: [
        override({ dueDate: "2026-06-01", amountCents: 150_00, notes: "pays-down:2026-06-10" }),
      ],
    });
    const pp = r.extras.filter((e) => e.sourceId === "c1");
    // The paydown still debits its own day in full…
    expect(pp.find((e) => e.date === "2026-06-01")?.amountCents).toBe(150_00);
    // …the target-date promo chunk is fully covered (gone)…
    expect(pp.some((e) => e.date === "2026-06-10")).toBe(false);
    // …and the 50_00 excess reduces the next promo chunk from 100 to 50.
    expect(pp.find((e) => e.date === "2026-07-10")?.amountCents).toBe(50_00);
    // Total card cash equals the promo balance (200_00) — never more.
    expect(pp.reduce((s, e) => s + e.amountCents, 0)).toBe(200_00);
  });

  it("leaves later promo chunks untouched when the paydown fits its target", () => {
    const r = projectCardPayments({
      ...base,
      cardPaymentOverrides: [
        override({ dueDate: "2026-06-01", amountCents: 40_00, notes: "pays-down:2026-06-10" }),
      ],
    });
    const pp = r.extras.filter((e) => e.sourceId === "c1");
    expect(pp.find((e) => e.date === "2026-06-10")?.amountCents).toBe(60_00);
    expect(pp.find((e) => e.date === "2026-07-10")?.amountCents).toBe(100_00);
  });
});
