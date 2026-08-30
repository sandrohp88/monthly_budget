import { describe, expect, it } from "vitest";
import {
  cardPaymentLateWarning,
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
    creditLimitCents: null,
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

type Result = ReturnType<typeof projectCardPayments>;
/** Zero-cash due-date markers. */
const markersOf = (r: Result) => r.extras.filter((e) => e.dueMarker);
/** Cash-out events (scheduled payments, promo, variable). */
const cashOf = (r: Result) => r.extras.filter((e) => !e.dueMarker);
const cashTotal = (r: Result) => cashOf(r).reduce((s, e) => s + e.amountCents, 0);

describe("projectCardPayments — due markers (no forced cash)", () => {
  it("projects a recorded statement as a zero-cash due marker on its due date", () => {
    const r = projectCardPayments({ ...EMPTY, activeCards: [card()], statements: [stmt()] });
    const m = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(m).toMatchObject({
      date: "2026-06-10",
      amountCents: 0,
      dueMarker: true,
      estimated: false,
      paymentDueCents: 200_00,
      scheduledCoverCents: 0,
      sourceType: "creditCardPayment",
    });
    // No cash leaves checking — nothing is scheduled.
    expect(cashTotal(r)).toBe(0);
  });

  it("an override on a statement due date is a cash payment that covers the marker", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt()],
      cardPaymentOverrides: [override({ dueDate: "2026-06-10", amountCents: 300_00 })],
    });
    const m = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(m).toMatchObject({ paymentDueCents: 200_00, scheduledCoverCents: 200_00 });
    const paid = cashOf(r).find((e) => e.date === "2026-06-10");
    expect(paid).toMatchObject({ amountCents: 300_00, description: "Card planned payment" });
    // Cash out is the scheduled payment only, not statement + payment.
    expect(cashTotal(r)).toBe(300_00);
  });

  it("a planned payment after a due date does not cover that due date", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt({ dueDate: "2026-06-10" })],
      cardPaymentOverrides: [override({ dueDate: "2026-07-10", amountCents: 150_00 })],
    });
    const june = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(june?.scheduledCoverCents).toBe(0);
    const planned = cashOf(r).find((e) => e.date === "2026-07-10");
    expect(planned).toMatchObject({ amountCents: 150_00, description: "Card planned payment" });
  });

  it("estimates the open cycle (and future cycles) as zero-cash markers", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ currentBalanceCents: 300_00 })],
    });
    // today 2026-05-04 → next close 2026-05-15 → due 2026-06-10, then 2026-07-10.
    const june = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(june).toMatchObject({ amountCents: 0, estimated: true, paymentDueCents: 300_00 });
    expect(markersOf(r).some((e) => e.date === "2026-07-10" && e.estimated)).toBe(true);
    expect(cashTotal(r)).toBe(0);
  });

  it("a recorded statement suppresses the estimate on its own due date", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ currentBalanceCents: 300_00 })],
      statements: [stmt({ statementBalanceCents: 200_00, dueDate: "2026-06-10" })],
    });
    const june = markersOf(r).filter((e) => e.date === "2026-06-10");
    expect(june).toHaveLength(1);
    expect(june[0]).toMatchObject({ estimated: false, paymentDueCents: 200_00 });
    // Later cycles fall back to the estimate (balance minus the unpaid statement).
    const july = markersOf(r).find((e) => e.date === "2026-07-10");
    expect(july).toMatchObject({ estimated: true, paymentDueCents: 100_00 });
  });

  it("records promo drift when promo principal exceeds the live-balance headroom", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ plaidAccountId: "acct1" })],
      plaidAccounts: [{ id: "acct1", balanceCents: 100_00 }],
      promos: [promo({ remainingAmountCents: 500_00 })],
    });
    // headroom 100_00, promo capped to 100_00 → drift 400_00; estimate nets to 0.
    expect(r.promoDriftByCard["c1"]).toBe(400_00);
    expect(markersOf(r).some((e) => e.estimated)).toBe(false);
  });

  it("keeps a promo cash chunk separate from the estimate marker on the same day", () => {
    // Card balance $500, promo $300 remaining. On 2026-06-10 the estimate marker
    // ($500 − $300 promo = $200, zero cash) and the promo's first cash chunk
    // ($50) both land — markers never merge into cash payments.
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ currentBalanceCents: 500_00 })],
      promos: [promo({ remainingAmountCents: 300_00, monthlyPaymentCents: 50_00 })],
    });
    const marker = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(marker).toMatchObject({ amountCents: 0, paymentDueCents: 200_00, estimated: true });
    const promoCash = cashOf(r).find((e) => e.date === "2026-06-10");
    expect(promoCash?.amountCents).toBe(50_00);
    expect(promoCash?.description).toContain("promo");
  });

  it("returns all markers ahead of cash-out events", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ currentBalanceCents: 900_00 })],
      statements: [stmt({ statementBalanceCents: 200_00, dueDate: "2026-06-10" })],
      promos: [promo({ remainingAmountCents: 300_00, monthlyPaymentCents: 50_00 })],
    });
    const firstCash = r.extras.findIndex((e) => !e.dueMarker);
    const lastMarker = r.extras.map((e) => Boolean(e.dueMarker)).lastIndexOf(true);
    expect(lastMarker).toBeLessThan(firstCash);
  });
});

describe("scheduled paydowns (pays-down overrides)", () => {
  it("a pending paydown covers the statement marker and debits its own date", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt({ statementBalanceCents: 200_00, dueDate: "2026-06-10" })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-20", amountCents: 80_00, notes: "pays-down:2026-06-10" }),
      ],
    });
    const marker = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(marker).toMatchObject({ paymentDueCents: 200_00, scheduledCoverCents: 80_00 });
    const planned = cashOf(r).find((e) => e.date === "2026-05-20");
    expect(planned).toMatchObject({
      amountCents: 80_00,
      description: "Card planned payment",
      paydownTargetDate: "2026-06-10",
    });
    // Only the scheduled payment moves cash — the statement never force-drains.
    expect(cashTotal(r)).toBe(80_00);
  });

  it("a paydown covering the whole statement marks it fully covered", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt({ statementBalanceCents: 200_00, dueDate: "2026-06-10" })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-20", amountCents: 200_00, notes: "pays-down:2026-06-10" }),
      ],
    });
    const marker = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(marker).toMatchObject({ paymentDueCents: 200_00, scheduledCoverCents: 200_00 });
    expect(cashTotal(r)).toBe(200_00);
  });

  it("a PAST-dated paydown does not cover the target marker", () => {
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
    const marker = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(marker).toMatchObject({ paymentDueCents: 200_00, scheduledCoverCents: 0 });
    // Any cash it emits is dated in the past (2026-05-01), so the projection
    // filters it — nothing on/after today covers the marker.
    expect(cashOf(r).some((e) => e.date >= "2026-05-04")).toBe(false);
  });

  it("consumes a paydown once across a promo chunk and its marker on the same date", () => {
    // Live balance 300 with promo remaining 100 → estimate marker 200 on
    // 2026-06-10; the promo's 50/mo chunk (cash) lands the same date. A 220
    // paydown covers the marker AND clears the promo cash — never double-spent.
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ currentBalanceCents: 300_00 })],
      promos: [promo({ remainingAmountCents: 100_00, monthlyPaymentCents: 50_00 })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-20", amountCents: 220_00, notes: "pays-down:2026-06-10" }),
      ],
    });
    const marker = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(marker).toMatchObject({ paymentDueCents: 200_00, scheduledCoverCents: 200_00 });
    // The promo cash chunk on 2026-06-10 is fully covered → dropped.
    expect(cashOf(r).some((e) => e.date === "2026-06-10")).toBe(false);
    // Cash out is the single 220 paydown.
    expect(cashTotal(r)).toBe(220_00);
  });

  it("a paydown with no matching marker is still a plain planned payment", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-20", amountCents: 50_00, notes: "pays-down:2026-06-10" }),
      ],
    });
    const cash = cashOf(r);
    expect(cash).toHaveLength(1);
    expect(cash[0]).toMatchObject({
      date: "2026-05-20",
      amountCents: 50_00,
      paydownTargetDate: "2026-06-10",
    });
  });

  it("a paydown with a STALE target still covers due markers like a plain payment", () => {
    // Regression: statement reconciliation / cycle edits can shift every
    // projected due date after a `pays-down:` note is written. The stored
    // target then matches no marker, no estimated due, and no promo chunk —
    // and the directed cash used to count as coverage NOWHERE, so a $3,455
    // payment four days before the due date left the marker warning about an
    // uncovered $832 (Prime Visa 9873, 2026-07-15).
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt({ statementBalanceCents: 200_00, dueDate: "2026-06-10" })],
      cardPaymentOverrides: [
        // 2026-06-25 is no slot at all: not a statement due, not an estimated
        // cycle due, not a promo/variable chunk date.
        override({ dueDate: "2026-05-20", amountCents: 80_00, notes: "pays-down:2026-06-25" }),
      ],
    });
    const marker = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(marker).toMatchObject({ paymentDueCents: 200_00, scheduledCoverCents: 80_00 });
    // The cash still debits its own date, exactly once.
    expect(cashOf(r).find((e) => e.date === "2026-05-20")?.amountCents).toBe(80_00);
    expect(cashTotal(r)).toBe(80_00);
  });

  it("a stale-target paydown's excess carries into the estimated cycles", () => {
    // Live balance 1000, statement 200 → estimate 800 on later cycles. A
    // 1200 paydown at a dead target covers the statement (200) and the full
    // estimate balance (800) on every estimated cycle.
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ currentBalanceCents: 1000_00 })],
      statements: [stmt({ statementBalanceCents: 200_00, dueDate: "2026-06-10" })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-20", amountCents: 1200_00, notes: "pays-down:2026-06-25" }),
      ],
    });
    const june = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(june).toMatchObject({ paymentDueCents: 200_00, scheduledCoverCents: 200_00 });
    const july = markersOf(r).find((e) => e.date === "2026-07-10" && e.estimated);
    expect(july).toMatchObject({ paymentDueCents: 800_00, scheduledCoverCents: 800_00 });
    expect(cashTotal(r)).toBe(1200_00);
  });

  it("a PAST-dated stale-target paydown still covers nothing", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt({ statementBalanceCents: 200_00, dueDate: "2026-06-10" })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-01", amountCents: 80_00, notes: "pays-down:2026-06-25" }),
      ],
    });
    const marker = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(marker).toMatchObject({ paymentDueCents: 200_00, scheduledCoverCents: 0 });
  });

  it("covers only its target marker, not the paydown's own-date marker", () => {
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
    // June marker is untouched (the paydown targets July, not its own date).
    const june = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(june).toMatchObject({ paymentDueCents: 200_00, scheduledCoverCents: 0 });
    // July marker is partly covered by the 80 paydown.
    const july = markersOf(r).find((e) => e.date === "2026-07-10");
    expect(july).toMatchObject({ paymentDueCents: 400_00, scheduledCoverCents: 80_00 });
    // The paydown's 80 debits its own date (2026-06-10).
    expect(cashOf(r).find((e) => e.date === "2026-06-10")?.amountCents).toBe(80_00);
    expect(cashTotal(r)).toBe(80_00);
  });
});

describe("running-balance estimate — a paydown carries forward to later cycles", () => {
  // A manual card with a static balance and no statements (e.g. CareCredit):
  // every future due is an estimate off ONE running balance, so paying it down
  // in one cycle must reduce the later cycles too, not snap back to the balance.
  it("a paydown clearing the balance covers this AND every later estimated cycle", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ currentBalanceCents: 1000_00 })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-20", amountCents: 1000_00, notes: "pays-down:2026-06-10" }),
      ],
    });
    const june = markersOf(r).find((e) => e.date === "2026-06-10");
    const july = markersOf(r).find((e) => e.date === "2026-07-10");
    expect(june).toMatchObject({ paymentDueCents: 1000_00, scheduledCoverCents: 1000_00 });
    expect(july).toMatchObject({ paymentDueCents: 1000_00, scheduledCoverCents: 1000_00 });
    // Only the single $1000 payment leaves checking.
    expect(cashTotal(r)).toBe(1000_00);
  });

  it("a partial paydown leaves the same remainder exposed on every later cycle", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ currentBalanceCents: 1000_00 })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-20", amountCents: 400_00, notes: "pays-down:2026-06-10" }),
      ],
    });
    const june = markersOf(r).find((e) => e.date === "2026-06-10");
    const july = markersOf(r).find((e) => e.date === "2026-07-10");
    // $600 still exposed on both cycles (not $600 then $1000).
    expect(june?.scheduledCoverCents).toBe(400_00);
    expect(july?.scheduledCoverCents).toBe(400_00);
  });

  it("a plain payment paid against the balance also carries forward", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ currentBalanceCents: 1000_00 })],
      cardPaymentOverrides: [override({ dueDate: "2026-05-20", amountCents: 1000_00, notes: null })],
    });
    expect(markersOf(r).find((e) => e.date === "2026-06-10")?.scheduledCoverCents).toBe(1000_00);
    expect(markersOf(r).find((e) => e.date === "2026-07-10")?.scheduledCoverCents).toBe(1000_00);
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

  it("allows moving a statement due after its due date — paying late is a choice", () => {
    expect(
      cardPaymentMoveError(
        { fromDate: "2026-06-10", isPaydown: false, paymentDueCents: 200_00 },
        "2026-06-11",
        today,
      ),
    ).toBeNull();
  });

  it("warns (non-blocking) when a real due moves past its issuer due date", () => {
    const input = {
      fromDate: "2026-06-04",
      isPaydown: false,
      paymentDueCents: 200_00,
      relatedDate: "2026-06-10",
    };
    // On/before the original issuer due date (relatedDate): no warning.
    expect(cardPaymentLateWarning(input, "2026-06-08")).toBeNull();
    // After it: allowed, but the interest note fires.
    expect(cardPaymentMoveError(input, "2026-06-12", today)).toBeNull();
    expect(cardPaymentLateWarning(input, "2026-06-12")).toContain("2026-06-10");
    // Paydowns and plain planned payments carry no issuer deadline → no warning.
    expect(
      cardPaymentLateWarning(
        { fromDate: "2026-06-04", isPaydown: true, paymentDueCents: 0 },
        "2026-09-30",
      ),
    ).toBeNull();
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

describe("projectCardPayments — overdue statements & late cover", () => {
  // EMPTY.today = 2026-05-04; all "overdue" statements below were due before that.

  it("an unpaid statement past its due date surfaces as an overdue marker on today", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt({ statementDate: "2026-03-15", dueDate: "2026-04-10" })],
    });
    const m = markersOf(r).find((e) => e.date === "2026-05-04");
    expect(m).toMatchObject({
      dueMarker: true,
      estimated: false,
      paymentDueCents: 200_00,
      scheduledCoverCents: 0,
      overdueSinceDate: "2026-04-10",
      relatedDate: "2026-04-10",
    });
    expect(m?.description).toContain("(overdue)");
    // Still zero-cash — an overdue balance is never force-paid either.
    expect(cashTotal(r)).toBe(0);
  });

  it("an archived card's unpaid statement produces no overdue marker", () => {
    // `statements` arrives with EVERY card's rows, archived ones included, but
    // `activeCards` holds only the wallet. A marker for a card the credit-cards
    // page won't list is an obligation the user can see but can't open, edit,
    // or clear — exactly the stale duplicate left behind when a manual card is
    // re-added as a Plaid-linked one and the manual original is archived.
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [],
      statements: [
        stmt({ cardId: "archived", statementDate: "2026-03-15", dueDate: "2026-04-10" }),
      ],
    });
    expect(r.extras).toHaveLength(0);
  });

  it("archiving one card leaves the surviving card's markers intact", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ id: "live", name: "Live" })],
      statements: [
        stmt({ cardId: "archived", cardName: "Archived", dueDate: "2026-04-10" }),
        stmt({ id: "s2", cardId: "live", cardName: "Live", dueDate: "2026-06-10" }),
      ],
    });
    expect(markersOf(r)).toHaveLength(1);
    expect(markersOf(r)[0]).toMatchObject({ date: "2026-06-10", sourceId: "live" });
  });

  it("a paid statement past its due date produces no overdue marker", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [
        stmt({ statementDate: "2026-03-15", dueDate: "2026-04-10", paidAmountCents: 200_00 }),
      ],
    });
    expect(markersOf(r)).toHaveLength(0);
  });

  it("multiple overdue statements on one card collapse into one marker (summed, earliest due)", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [
        stmt({
          id: "s1",
          statementDate: "2026-02-15",
          dueDate: "2026-03-10",
          statementBalanceCents: 100_00,
        }),
        stmt({
          id: "s2",
          statementDate: "2026-03-15",
          dueDate: "2026-04-10",
          statementBalanceCents: 40_00,
        }),
      ],
    });
    const overdueMarkers = markersOf(r).filter((e) => e.overdueSinceDate);
    expect(overdueMarkers).toHaveLength(1);
    expect(overdueMarkers[0]).toMatchObject({
      date: "2026-05-04",
      paymentDueCents: 140_00,
      overdueSinceDate: "2026-03-10",
    });
  });

  it("any scheduled payment covers an overdue marker — as LATE cover", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt({ statementDate: "2026-03-15", dueDate: "2026-04-10" })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-20", amountCents: 200_00, notes: null }),
      ],
    });
    const m = markersOf(r).find((e) => e.overdueSinceDate);
    expect(m).toMatchObject({ scheduledCoverCents: 200_00, lateCoverCents: 200_00 });
  });

  it("a stale paydown targeting the passed due date still covers the overdue marker", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt({ statementDate: "2026-03-15", dueDate: "2026-04-10" })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-20", amountCents: 200_00, notes: "pays-down:2026-04-10" }),
      ],
    });
    const m = markersOf(r).find((e) => e.overdueSinceDate);
    expect(m).toMatchObject({ scheduledCoverCents: 200_00, lateCoverCents: 200_00 });
  });

  it("a moved payment dated after its due date is directed LATE cover for that due", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt({ dueDate: "2026-06-10" })],
      cardPaymentOverrides: [
        override({ id: "o1", dueDate: "2026-06-10", amountCents: 0, notes: "moved-to:2026-06-20" }),
        override({
          id: "o2",
          dueDate: "2026-06-20",
          amountCents: 200_00,
          notes: "moved-from:2026-06-10",
        }),
      ],
    });
    const m = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(m).toMatchObject({ scheduledCoverCents: 200_00, lateCoverCents: 200_00 });
    // The cash debits its own (late) day, not the due date.
    const paid = cashOf(r).find((e) => e.date === "2026-06-20");
    expect(paid?.amountCents).toBe(200_00);
  });

  it("an overdue marker drinks from the pool before future statements", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [
        stmt({
          id: "s1",
          statementDate: "2026-03-15",
          dueDate: "2026-04-10",
          statementBalanceCents: 150_00,
        }),
        stmt({
          id: "s2",
          statementDate: "2026-05-15",
          dueDate: "2026-06-10",
          statementBalanceCents: 200_00,
        }),
      ],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-20", amountCents: 150_00, notes: null }),
      ],
    });
    const overdueMarker = markersOf(r).find((e) => e.overdueSinceDate);
    const june = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(overdueMarker).toMatchObject({ scheduledCoverCents: 150_00, lateCoverCents: 150_00 });
    expect(june?.scheduledCoverCents).toBe(0);
  });

  it("on-time cover stays on-time — lateCoverCents is 0 for a payment before the due date", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt({ dueDate: "2026-06-10" })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-06-01", amountCents: 200_00, notes: null }),
      ],
    });
    const m = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(m).toMatchObject({ scheduledCoverCents: 200_00, lateCoverCents: 0 });
  });
});

describe("projectCardPayments — $0 skip overrides & minimum payment", () => {
  // EMPTY.today = 2026-05-04. card() has a 500_00 promo helper available.

  it("an explicit $0 override skips a promo chunk's cash for that cycle", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      promos: [promo({ monthlyPaymentCents: 50_00 })],
      cardPaymentOverrides: [override({ dueDate: "2026-06-10", amountCents: 0, notes: null })],
    });
    // The June chunk carries no cash but stays visible (resettable).
    const june = cashOf(r).find((e) => e.date === "2026-06-10");
    expect(june).toMatchObject({ amountCents: 0, paymentDueCents: 0 });
    expect(june?.description).toContain("— skipped");
    expect(june?.originalAmountCents).toBe(50_00);
    // Later cycles are untouched — skipping one cycle isn't skipping the plan.
    const july = cashOf(r).find((e) => e.date === "2026-07-10");
    expect(july?.amountCents).toBe(50_00);
  });

  it("a moved-to vacate row is NOT a skip — vacate mechanics unchanged", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      promos: [promo({ monthlyPaymentCents: 50_00 })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-06-10", amountCents: 0, notes: "moved-to:2026-06-01" }),
        override({ id: "o2", dueDate: "2026-06-01", amountCents: 50_00, notes: "moved-from:2026-06-10" }),
      ],
    });
    // The moved payment debits its own date; the chunk is absorbed via the
    // prepay pool, not left double-counted; and no "skipped" row appears.
    const total = cashOf(r).reduce((s, e) => s + e.amountCents, 0);
    expect(total).toBe(500_00); // full promo remaining across the window, not 550
    expect(cashOf(r).some((e) => e.description.includes("— skipped"))).toBe(false);
    // Directed absorption: the VACATED cycle's chunk is the one canceled — the
    // moved cash must not knock out a different month's payment instead.
    expect(cashOf(r).some((e) => e.date === "2026-06-10")).toBe(false);
    expect(cashOf(r).find((e) => e.date === "2026-05-10")?.amountCents).toBe(50_00);
  });

  it("a moved variable-spend payment is absorbed, not double-counted", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      variableBills: [
        {
          id: "vb1",
          userId: "u1",
          name: "Groceries",
          category: "Food",
          amountCents: 400_00,
          intervalMonths: 1,
          anchorDate: "2026-05-05",
          notes: null,
          isActive: true,
          createdAt: 0,
          updatedAt: 0,
          cardIds: ["c1"],
        },
      ],
      cardPaymentOverrides: [
        override({ dueDate: "2026-06-10", amountCents: 0, notes: "moved-to:2026-06-01" }),
        override({ id: "o2", dueDate: "2026-06-01", amountCents: 400_00, notes: "moved-from:2026-06-10" }),
      ],
    });
    // Three charges project in the window; moving June's payment must not add
    // cash (the vacated 06-10 chunk is canceled by the moved cash).
    const total = cashOf(r).reduce((s, e) => s + e.amountCents, 0);
    expect(total).toBe(1200_00);
    expect(cashOf(r).some((e) => e.date === "2026-06-10" && e.amountCents > 0)).toBe(false);
  });

  it("a $0 override on a variable-spend charge skips that cycle's cash", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      variableBills: [
        {
          id: "vb1",
          userId: "u1",
          name: "Groceries",
          category: "Food",
          amountCents: 400_00,
          intervalMonths: 1,
          anchorDate: "2026-05-05",
          notes: null,
          isActive: true,
          createdAt: 0,
          updatedAt: 0,
          cardIds: ["c1"],
        },
      ],
      cardPaymentOverrides: [override({ dueDate: "2026-06-10", amountCents: 0, notes: null })],
    });
    const june = cashOf(r).find((e) => e.date === "2026-06-10");
    expect(june).toMatchObject({ amountCents: 0, paymentDueCents: 0 });
    expect(june?.description).toContain("— skipped");
  });

  it("skipped rows carry the structured skipped flag", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      promos: [promo({ monthlyPaymentCents: 50_00 })],
      cardPaymentOverrides: [override({ dueDate: "2026-06-10", amountCents: 0, notes: null })],
    });
    expect(cashOf(r).find((e) => e.date === "2026-06-10")?.skipped).toBe(true);
    expect(cashOf(r).find((e) => e.date === "2026-07-10")?.skipped).toBeUndefined();
  });

  it("a skip covering promo + variable on one date survives the merge", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      promos: [promo({ monthlyPaymentCents: 50_00 })],
      variableBills: [
        {
          id: "vb1",
          userId: "u1",
          name: "Groceries",
          category: "Food",
          amountCents: 400_00,
          intervalMonths: 1,
          anchorDate: "2026-05-05",
          notes: null,
          isActive: true,
          createdAt: 0,
          updatedAt: 0,
          cardIds: ["c1"],
        },
      ],
      cardPaymentOverrides: [override({ dueDate: "2026-06-10", amountCents: 0, notes: null })],
    });
    // One $0 override zeroes both chunk kinds; the merged row must still read
    // as a skip (flag AND label) so the calendar can show/reset it.
    const june = cashOf(r).filter((e) => e.date === "2026-06-10");
    expect(june).toHaveLength(1);
    expect(june[0]).toMatchObject({ amountCents: 0, skipped: true });
    expect(june[0]!.description).toContain("— skipped");
  });

  it("a statement marker carries the issuer minimum still owed", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt({ minimumPaymentCents: 35_00 })],
    });
    const m = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(m?.paymentMinimumCents).toBe(35_00);
  });

  it("partial payments reduce the outstanding minimum first", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [stmt({ minimumPaymentCents: 35_00, paidAmountCents: 20_00 })],
    });
    const m = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(m?.paymentMinimumCents).toBe(15_00);
  });

  it("an overdue aggregate sums the outstanding minimums", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      statements: [
        stmt({
          id: "s1",
          statementDate: "2026-02-15",
          dueDate: "2026-03-10",
          statementBalanceCents: 100_00,
          minimumPaymentCents: 25_00,
        }),
        stmt({
          id: "s2",
          statementDate: "2026-03-15",
          dueDate: "2026-04-10",
          statementBalanceCents: 40_00,
          minimumPaymentCents: 10_00,
        }),
      ],
    });
    const m = markersOf(r).find((e) => e.overdueSinceDate);
    expect(m?.paymentMinimumCents).toBe(35_00);
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

describe("projectCardPayments — a plain planned payment covers a statement marker", () => {
  const base = {
    ...EMPTY,
    today: "2026-07-13",
    endDate: "2026-12-31",
    activeCards: [card({ currentBalanceCents: null, dueDay: 8 })],
  };

  it("a scheduled payment before a statement covers its marker (no double-count)", () => {
    // Mirrors the real ****1434 bug: $1,111 planned Aug 3, statement $1,110.41 due Aug 8.
    const r = projectCardPayments({
      ...base,
      statements: [
        stmt({ statementDate: "2026-07-10", dueDate: "2026-08-08", statementBalanceCents: 111041, paidAmountCents: null }),
      ],
      cardPaymentOverrides: [override({ dueDate: "2026-08-03", amountCents: 111100, notes: null })],
    });
    // The scheduled payment debits its own day…
    expect(cashOf(r).find((e) => e.date === "2026-08-03")?.amountCents).toBe(111100);
    // …the statement due date is a covered marker (no cash of its own)…
    const marker = markersOf(r).find((e) => e.date === "2026-08-08");
    expect(marker).toMatchObject({ amountCents: 0, paymentDueCents: 111041, scheduledCoverCents: 111041 });
    // …and total cash = the single scheduled payment, not payment + statement.
    expect(cashTotal(r)).toBe(111100);
  });

  it("a partial scheduled payment leaves the marker partly covered", () => {
    const r = projectCardPayments({
      ...base,
      statements: [
        stmt({ statementDate: "2026-07-10", dueDate: "2026-08-08", statementBalanceCents: 100_00, paidAmountCents: null }),
      ],
      cardPaymentOverrides: [override({ dueDate: "2026-08-03", amountCents: 30_00, notes: null })],
    });
    expect(cashOf(r).find((e) => e.date === "2026-08-03")?.amountCents).toBe(30_00);
    const marker = markersOf(r).find((e) => e.date === "2026-08-08");
    expect(marker).toMatchObject({ paymentDueCents: 100_00, scheduledCoverCents: 30_00 });
    // Only the scheduled 30 leaves checking — the 70 shortfall accrues interest.
    expect(cashTotal(r)).toBe(30_00);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Interest Saving Balance — golden numbers from the real Chase Prime Visa
// 07/10/26 statement: New Balance $1,220.11, four Equal Pay plans totaling
// $496.01 remaining with $108.16 of plan payments billed this cycle, printed
// ISB $832.26, live balance $1,555.19 four days after close.
// ────────────────────────────────────────────────────────────────────────────
describe("projectCardPayments — interest-saving balance on promo cards", () => {
  const chaseShape = {
    ...EMPTY,
    today: "2026-07-14",
    endDate: "2026-10-01",
    activeCards: [card({ id: "chase", name: "Prime Visa", statementDay: 10, dueDay: 7, plaidAccountId: "acct9873" })],
    plaidAccounts: [{ id: "acct9873", balanceCents: 1555_19 }],
    statements: [
      stmt({
        id: "s-0710",
        cardId: "chase",
        cardName: "Prime Visa",
        statementDate: "2026-07-10",
        dueDate: "2026-08-07",
        statementBalanceCents: 1220_11,
        minimumPaymentCents: 143_16,
      }),
    ],
    promos: [
      promo({ id: "ep1", cardId: "chase", remainingAmountCents: 73_37, endDate: "2026-10-07", monthlyPaymentCents: null }),
      promo({ id: "ep2", cardId: "chase", remainingAmountCents: 123_23, endDate: "2026-11-07", monthlyPaymentCents: 30_82 }),
      promo({ id: "ep3", cardId: "chase", remainingAmountCents: 89_09, endDate: "2026-12-07", monthlyPaymentCents: 17_82 }),
      promo({ id: "ep4", cardId: "chase", remainingAmountCents: 210_32, endDate: "2027-01-07", monthlyPaymentCents: 35_06 }),
    ],
  };

  it("the statement marker owes the ISB, not the full balance", () => {
    const r = projectCardPayments(chaseShape);
    const marker = markersOf(r).find((e) => e.date === "2026-08-07");
    // $832.26 exposed to interest; the other $387.85 is 0% promo principal
    // already projected as later promo chunks.
    expect(marker).toMatchObject({
      amountCents: 0,
      dueMarker: true,
      estimated: false,
      paymentDueCents: 832_26,
    });
  });

  it("the open-cycle estimate is the post-close spend — promo principal is not subtracted twice", () => {
    const r = projectCardPayments(chaseShape);
    // live 1,555.19 − non-promo unpaid (1,220.11 − 496.01) − promo 496.01 = 335.08.
    const est = markersOf(r).find((e) => e.estimated);
    expect(est).toMatchObject({ paymentDueCents: 335_08 });
    // No phantom drift: the promo principal fits inside the statement balance.
    expect(r.promoDriftByCard["chase"]).toBeUndefined();
  });

  it("an ISB payment fully covers the statement marker", () => {
    const r = projectCardPayments({
      ...chaseShape,
      cardPaymentOverrides: [
        override({ cardId: "chase", dueDate: "2026-08-05", amountCents: 832_26 }),
      ],
    });
    const marker = markersOf(r).find((e) => e.date === "2026-08-07");
    expect(marker).toMatchObject({ paymentDueCents: 832_26, scheduledCoverCents: 832_26 });
  });
});

describe("projectCardPayments — userScheduled flag", () => {
  it("planned payments and paydowns carry userScheduled; promo/variable cash does not", () => {
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      promos: [promo({ remainingAmountCents: 300_00, monthlyPaymentCents: 50_00 })],
      cardPaymentOverrides: [
        // plain scheduled payment on its own date (no cash chunk there)
        override({ dueDate: "2026-05-20", amountCents: 75_00 }),
        // paydown targeting the promo's 2026-06-10 chunk
        override({
          id: "o2",
          dueDate: "2026-05-25",
          amountCents: 20_00,
          notes: "pays-down:2026-06-10",
        }),
      ],
    });
    const cash = r.extras.filter((e) => !e.dueMarker);
    const planned = cash.find((e) => e.date === "2026-05-20");
    const paydown = cash.find((e) => e.date === "2026-05-25");
    const promoChunk = cash.find((e) => e.date === "2026-06-10");
    expect(planned?.userScheduled).toBe(true);
    expect(paydown?.userScheduled).toBe(true);
    expect(promoChunk?.userScheduled).toBeFalsy();
  });

  it("a merged cash row containing any planned payment keeps userScheduled", () => {
    // A plain payment and a paydown share 2026-05-20 -> mergeByDueDate folds
    // them into one cash row; the plan semantics must survive the merge.
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      promos: [promo({ remainingAmountCents: 300_00, monthlyPaymentCents: 50_00 })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-20", amountCents: 75_00 }),
        override({ id: "o2", dueDate: "2026-05-20", amountCents: 25_00, notes: "pays-down:2026-07-10" }),
      ],
    });
    const merged = r.extras.find((e) => !e.dueMarker && e.date === "2026-05-20");
    expect(merged?.amountCents).toBe(100_00);
    expect(merged?.userScheduled).toBe(true);
  });
});
