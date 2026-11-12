import { describe, expect, it } from "vitest";
import {
  cardPaymentLateWarning,
  cardPaymentMoveError,
  projectCardPayments,
  type StatementWithCardName,
} from "./card-payments";
import { computeProjection } from "./projection";
import { findUncoveredCardDues } from "./projection-insights";
import { interestDigest } from "./push-payload";
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
    trackPosting: true,
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
    // 2026-06-10; the promo's 50/mo chunks (cash) land on 2026-05-10 and on
    // the same 2026-06-10. A 220 paydown has ONE budget: 200 covers the
    // marker, the last 20 reduces the 06-10 chunk — never double-spent.
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
    // The 30 the paydown can't reach stays owed as promo cash on 06-10.
    expect(cashOf(r).find((e) => e.date === "2026-06-10")?.amountCents).toBe(30_00);
    // The 05-10 chunk predates the paydown (05-20): untouched.
    expect(cashOf(r).find((e) => e.date === "2026-05-10")?.amountCents).toBe(50_00);
    // Cash out = the 220 paydown + the 80 of promo cash it doesn't cover.
    expect(cashTotal(r)).toBe(220_00 + 30_00 + 50_00);
  });

  it("a paydown on an estimated due that also carries a promo chunk is credited once", () => {
    // Without a paydown: estimate 200 on 06-10 and 07-10 (one running balance),
    // promo cash 50 on 05-10 and 50 on 06-10. A 200 paydown on 05-20 aimed at
    // 06-10 covers the estimate balance and nothing else: both promo chunks
    // stay cash (the 05-10 one is dated before the money even leaves).
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ currentBalanceCents: 300_00 })],
      promos: [promo({ remainingAmountCents: 100_00, monthlyPaymentCents: 50_00 })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-20", amountCents: 200_00, notes: "pays-down:2026-06-10" }),
      ],
    });
    const june = markersOf(r).find((e) => e.date === "2026-06-10");
    const july = markersOf(r).find((e) => e.date === "2026-07-10");
    expect(june).toMatchObject({ estimated: true, paymentDueCents: 200_00, scheduledCoverCents: 200_00 });
    // This PR keeps the pre-existing carried-balance rule for estimate cover:
    // estimate markers are treated as ONE carried balance, so the same $200
    // shows as cover on 06-10 and on 07-10. For a card with ongoing spending
    // that over-credits 07-10 and hides its alert. Whether a later cycle's
    // estimate should be covered by an earlier paydown is an open question
    // recorded in the 2026-11-10 review; behavior unchanged here.
    expect(july).toMatchObject({ estimated: true, paymentDueCents: 200_00, scheduledCoverCents: 200_00 });
    expect(cashOf(r).find((e) => e.date === "2026-05-10")?.amountCents).toBe(50_00);
    expect(cashOf(r).find((e) => e.date === "2026-06-10")?.amountCents).toBe(50_00);
    expect(cashTotal(r)).toBe(300_00);
    // The card page's promo planner reads this: the full $100 is still owed.
    expect(r.promoCashByCard).toEqual({ c1: 100_00 });
  });

  it("a paydown dragged after its target still replaces that target's promo chunk", () => {
    // Directed cash (like a moved-from payment): the 06-10 chunk is paid by the
    // 06-15 paydown, so it is not projected twice. Only the undirected excess
    // sweep is limited to chunks dated on/after the paydown.
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      promos: [promo({ remainingAmountCents: 500_00, monthlyPaymentCents: 50_00 })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-06-15", amountCents: 120_00, notes: "pays-down:2026-06-10" }),
      ],
    });
    expect(cashOf(r).some((e) => e.date === "2026-06-10")).toBe(false);
    expect(cashOf(r).find((e) => e.date === "2026-05-10")?.amountCents).toBe(50_00);
    // Excess 70: the 07-10 chunk (after 06-15) absorbs 50, 08-10 the last 20.
    expect(cashOf(r).some((e) => e.date === "2026-07-10")).toBe(false);
    expect(cashOf(r).find((e) => e.date === "2026-08-10")?.amountCents).toBe(30_00);
    // The promo total (500) is paid exactly once: 120 by the paydown, 380 as chunks.
    expect(cashTotal(r)).toBe(500_00);
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

describe("projectCardPayments — one budget per paydown across every generator (§17a)", () => {
  // EMPTY.today = 2026-05-04; card(): statement day 15, due day 10.
  const groceries = (over: { amountCents?: number; anchorDate?: string } = {}) => ({
    id: "vb1",
    userId: "u1",
    name: "Groceries",
    category: "Food",
    amountCents: over.amountCents ?? 400_00,
    intervalMonths: 1,
    anchorDate: over.anchorDate ?? "2026-05-05",
    notes: null,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    cardIds: ["c1"],
  });
  // Live 300 + promo 100 at 50/mo → estimate 200 on 06-10 and 07-10 (one
  // running balance), promo cash 50 on 05-10 and 50 on 06-10.
  const estimateWithPromo = {
    ...EMPTY,
    activeCards: [card({ currentBalanceCents: 300_00 })],
    promos: [promo({ remainingAmountCents: 100_00, monthlyPaymentCents: 50_00 })],
  };
  // A recorded 200 statement due 06-10 plus a 400 variable-spend charge whose
  // card due date is the same 06-10 (variable spend has no recorded-statement
  // skip, so the two collide).
  const statementWithVariable = {
    ...EMPTY,
    activeCards: [card()],
    statements: [stmt({ statementBalanceCents: 200_00, dueDate: "2026-06-10" })],
    variableBills: [groceries()],
  };
  const paydown = (id: string, date: string, amountCents: number, target = "2026-06-10") =>
    override({ id, dueDate: date, amountCents, notes: `pays-down:${target}` });

  type Input = Parameters<typeof projectCardPayments>[0];
  const shapes: Array<{
    name: string;
    base: Input;
    paydowns: CreditCardPaymentOverrideRow[];
    /** Exact single-budget credit (marker cover + chunk cash removed). */
    credited: number;
  }> = [
    { name: "smaller than the marker", base: estimateWithPromo, paydowns: [paydown("a", "2026-05-20", 120_00)], credited: 120_00 },
    { name: "equal to the marker", base: estimateWithPromo, paydowns: [paydown("a", "2026-05-20", 200_00)], credited: 200_00 },
    { name: "equal to marker + chunk", base: estimateWithPromo, paydowns: [paydown("a", "2026-05-20", 250_00)], credited: 250_00 },
    // Excess after marker + target chunk finds no chunk dated on/after 05-20.
    { name: "larger, dated after the earlier chunk", base: estimateWithPromo, paydowns: [paydown("a", "2026-05-20", 400_00)], credited: 250_00 },
    // Dated before the 05-10 chunk, the excess may prepay it.
    { name: "larger, dated before the earlier chunk", base: estimateWithPromo, paydowns: [paydown("a", "2026-05-05", 400_00)], credited: 300_00 },
    {
      name: "two paydowns on one target",
      base: estimateWithPromo,
      paydowns: [paydown("a", "2026-05-20", 150_00), paydown("b", "2026-05-25", 100_00)],
      credited: 250_00,
    },
    { name: "recorded statement with a colliding chunk", base: statementWithVariable, paydowns: [paydown("a", "2026-05-20", 300_00)], credited: 300_00 },
    {
      name: "estimate + promo + variable spend on one date",
      base: { ...estimateWithPromo, variableBills: [groceries()] },
      paydowns: [paydown("a", "2026-05-20", 300_00)],
      credited: 300_00,
    },
  ];

  for (const shape of shapes) {
    it(`credits a paydown at most once — ${shape.name}`, () => {
      const before = projectCardPayments(shape.base);
      const after = projectCardPayments({ ...shape.base, cardPaymentOverrides: shape.paydowns });
      const paid = shape.paydowns.reduce((s, p) => s + p.amountCents, 0);
      const firstPaydownDate = shape.paydowns.map((p) => p.dueDate).sort()[0]!;

      const statementCover = markersOf(after)
        .filter((m) => !m.estimated)
        .reduce((s, m) => s + (m.scheduledCoverCents ?? 0), 0);
      // Math.max deliberately counts the carried estimate balance once, so this
      // does not test the per-cycle question (see the 2026-11-10 review).
      const estimateCover = Math.max(
        0,
        ...markersOf(after)
          .filter((m) => m.estimated)
          .map((m) => m.scheduledCoverCents ?? 0),
      );
      // Planned payments always debit in full, so the rest of the cash is the
      // promo/variable chunks the paydowns did not remove.
      const chunkCashRemoved = cashTotal(before) - (cashTotal(after) - paid);
      const credited = statementCover + estimateCover + chunkCashRemoved;

      expect(credited).toBeLessThanOrEqual(paid);
      expect(credited).toBe(shape.credited);
      // No chunk dated before the (earliest) paydown is reduced or cancelled.
      const cashOn = (r: Result, date: string) =>
        cashOf(r)
          .filter((e) => e.date === date)
          .reduce((s, e) => s + e.amountCents, 0);
      for (const e of cashOf(before)) {
        if (e.date < firstPaydownDate) expect(cashOn(after, e.date)).toBe(cashOn(before, e.date));
      }
    });
  }

  it("promoCashByCard is the promo cash the projection still debits", () => {
    // Read by the card page's promo planner instead of its own arithmetic.
    const promoCash = (r: Result) =>
      cashOf(r)
        .filter((e) => e.description.includes("promo"))
        .reduce((s, e) => s + e.amountCents, 0);
    const cases: Array<{ overrides: CreditCardPaymentOverrideRow[]; expected: number }> = [
      { overrides: [], expected: 100_00 },
      // Marker first: a 200 paydown leaves both 50 chunks owed.
      { overrides: [paydown("a", "2026-05-20", 200_00)], expected: 100_00 },
      { overrides: [paydown("a", "2026-05-20", 250_00)], expected: 50_00 },
      { overrides: [paydown("a", "2026-05-05", 400_00)], expected: 0 },
      // A $0 skip on 06-10 projects no cash there.
      { overrides: [override({ dueDate: "2026-06-10", amountCents: 0 })], expected: 50_00 },
    ];
    for (const { overrides, expected } of cases) {
      const r = projectCardPayments({ ...estimateWithPromo, cardPaymentOverrides: overrides });
      expect(r.promoCashByCard["c1"] ?? 0).toBe(expected);
      expect(promoCash(r)).toBe(expected);
    }
    // Chunks run to the promo deadline (12-31) but the calendar ends at
    // EMPTY.endDate (08-01): only 05-10, 06-10 and 07-10 count.
    const long = projectCardPayments({
      ...EMPTY,
      activeCards: [card()],
      promos: [promo({ remainingAmountCents: 500_00, monthlyPaymentCents: 50_00 })],
    });
    expect(promoCash(long)).toBe(500_00);
    expect(long.promoCashByCard).toEqual({ c1: 150_00 });
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

// DATA-1: a negative statement balance (the card carries a credit) is stored
// and restored as-is; the projection must treat it as nothing due.
describe("projectCardPayments — negative statement balance", () => {
  it("raises no due marker and debits no cash, on time or overdue", () => {
    for (const dueDate of ["2026-06-10", "2026-05-01"]) {
      const r = projectCardPayments({
        ...EMPTY,
        activeCards: [card()],
        statements: [stmt({ statementBalanceCents: -25_00, minimumPaymentCents: 0, dueDate })],
      });
      expect(markersOf(r)).toEqual([]);
      expect(cashTotal(r)).toBe(0);
    }
  });

  it("does not inflate the open-cycle estimate", () => {
    // Live balance $300; a -$25 credit statement must not count as -$25 unpaid
    // (which would grow the estimate to $325).
    const r = projectCardPayments({
      ...EMPTY,
      activeCards: [card({ currentBalanceCents: 300_00 })],
      statements: [stmt({ statementBalanceCents: -25_00, dueDate: "2026-05-01" })],
    });
    const june = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(june).toMatchObject({ estimated: true, paymentDueCents: 300_00 });
    expect(markersOf(r).every((e) => (e.paymentDueCents ?? 0) >= 0)).toBe(true);
    expect(cashTotal(r)).toBe(0);
  });
});

// PROJ-4: a statement cycle that already CLOSED but has no recorded statement
// row (a manual card before the user enters it, a Plaid card before the next
// liabilities sync) still owes on its issuer due date. The estimate used to
// start at the NEXT close, so the balance read as due one cycle late and the
// 14-day interest alert missed the real due date.
describe("projectCardPayments — closed cycle with no recorded statement", () => {
  const estDates = (r: Result) =>
    markersOf(r)
      .filter((e) => e.estimated)
      .map((e) => e.date);

  it("marks the closed cycle's due date with an estimate (today 2026-05-20, closed 05-15)", () => {
    const r = projectCardPayments({
      ...EMPTY,
      today: "2026-05-20",
      activeCards: [card({ currentBalanceCents: 300_00 })],
    });
    const june = markersOf(r).filter((e) => e.date === "2026-06-10");
    expect(june).toHaveLength(1);
    expect(june[0]).toMatchObject({
      amountCents: 0,
      estimated: true,
      paymentDueCents: 300_00,
      paymentBalanceCents: 300_00,
      scheduledCoverCents: 0,
      description: "Card (est.)",
    });
    // The next cycle keeps the carried-forward RUN RATE (§14 gotcha 26): the
    // same estimate, not a second $300 of debt and not $0.
    const july = markersOf(r).filter((e) => e.date === "2026-07-10");
    expect(july).toHaveLength(1);
    expect(july[0]).toMatchObject({ estimated: true, paymentDueCents: 300_00 });
    expect(estDates(r)).toEqual(["2026-06-10", "2026-07-10"]);
    expect(cashTotal(r)).toBe(0);
  });

  it("the interest alert sees it inside 14 days, and its digest is stable day to day", () => {
    const duesOn = (today: string) => {
      const r = projectCardPayments({
        ...EMPTY,
        today,
        activeCards: [card({ currentBalanceCents: 300_00 })],
      });
      const rows = computeProjection({
        startingBalanceCents: 1000_00,
        startDate: today,
        endDate: "2026-08-01",
        paychecks: [],
        bills: [],
        extras: r.extras,
      });
      return findUncoveredCardDues(rows, { today, horizonDays: 14 });
    };
    const dues = duesOn("2026-05-28");
    expect(dues).toHaveLength(1);
    expect(dues[0]).toMatchObject({
      dueDate: "2026-06-10",
      owedCents: 300_00,
      shortfallCents: 300_00,
      estimated: true,
    });
    // The marker sits on the fixed issuer due date, so the push digest does
    // not churn while the state is unchanged.
    expect(interestDigest(duesOn("2026-05-29"))).toBe(interestDigest(dues));
  });

  it("on the statement day itself the cycle is still open (both helpers agree)", () => {
    // nextStatementDateOnOrAfter(05-15) = 05-15: the close dated today is the
    // open cycle. The closed one is 04-15, whose due (05-10) already passed.
    const onClose = projectCardPayments({
      ...EMPTY,
      today: "2026-05-15",
      activeCards: [card({ currentBalanceCents: 300_00 })],
    });
    expect(estDates(onClose)).toEqual(["2026-06-10", "2026-07-10"]);
    // One day later the 05-15 cycle is closed: same due date, still one marker.
    const dayAfter = projectCardPayments({
      ...EMPTY,
      today: "2026-05-16",
      activeCards: [card({ currentBalanceCents: 300_00 })],
    });
    expect(estDates(dayAfter)).toEqual(["2026-06-10", "2026-07-10"]);
  });

  it("before the close, the previous cycle's due date gets the estimate too", () => {
    // today 05-04: the 04-15 cycle closed with no statement; it is due 05-10.
    const r = projectCardPayments({
      ...EMPTY,
      today: "2026-05-04",
      activeCards: [card({ currentBalanceCents: 300_00 })],
    });
    expect(estDates(r)).toEqual(["2026-05-10", "2026-06-10", "2026-07-10"]);
  });

  it("on the due date the marker sits on today; once it passed, no overdue is invented", () => {
    const onDue = projectCardPayments({
      ...EMPTY,
      today: "2026-06-10",
      activeCards: [card({ currentBalanceCents: 300_00 })],
    });
    expect(estDates(onDue)).toEqual(["2026-06-10", "2026-07-10"]);
    const after = projectCardPayments({
      ...EMPTY,
      today: "2026-06-11",
      activeCards: [card({ currentBalanceCents: 300_00 })],
    });
    // No statement = no evidence of an overdue debt: nothing on today, nothing
    // overdue; the balance stays estimated on the next cycle.
    expect(markersOf(after).some((e) => e.overdueSinceDate != null)).toBe(false);
    expect(estDates(after)).toEqual(["2026-07-10"]);
  });

  it("interval_days cycles: the closed interval's due date is marked", () => {
    // Closes every 28 days from 04-01: 04-29 (closed), 05-27 (open).
    // 04-29 + 14 = 05-13 → due 05-20; 05-27 + 14 = 06-10 → due 06-20.
    const r = projectCardPayments({
      ...EMPTY,
      today: "2026-05-10",
      activeCards: [
        card({
          currentBalanceCents: 300_00,
          statementCycleMode: "interval_days",
          statementCycleAnchorDate: "2026-04-01",
          statementCycleIntervalDays: 28,
          dueDay: 20,
        }),
      ],
    });
    expect(estDates(r)).toEqual(["2026-05-20", "2026-06-20", "2026-07-20"]);
  });

  it("a December close is due in January (due day earlier in the month than the close)", () => {
    const r = projectCardPayments({
      ...EMPTY,
      today: "2026-12-20",
      endDate: "2027-02-28",
      activeCards: [card({ currentBalanceCents: 300_00 })],
    });
    expect(estDates(r)).toEqual(["2027-01-10", "2027-02-10"]);
  });

  it("uses the grace period, not the next due day after today", () => {
    // Close on the 5th, due day 20, 21-day grace: the 05-05 close is due 06-20
    // (05-26 is past 05-20), not 05-20.
    const r = projectCardPayments({
      ...EMPTY,
      today: "2026-05-10",
      activeCards: [
        card({ currentBalanceCents: 300_00, statementDay: 5, dueDay: 20, gracePeriodDays: 21 }),
      ],
    });
    expect(estDates(r)).toEqual(["2026-06-20", "2026-07-20"]);
  });

  it("a zero or credit balance gets no estimate", () => {
    for (const balance of [0, -25_00]) {
      const r = projectCardPayments({
        ...EMPTY,
        today: "2026-05-20",
        activeCards: [card({ currentBalanceCents: balance })],
      });
      expect(markersOf(r)).toEqual([]);
    }
  });

  it("a recorded statement for that close is authoritative — no duplicate estimate", () => {
    const r = projectCardPayments({
      ...EMPTY,
      today: "2026-05-20",
      activeCards: [card({ currentBalanceCents: 300_00 })],
      statements: [stmt({ statementBalanceCents: 200_00 })],
    });
    const june = markersOf(r).filter((e) => e.date === "2026-06-10");
    expect(june).toHaveLength(1);
    expect(june[0]).toMatchObject({ estimated: false, paymentDueCents: 200_00 });
    expect(estDates(r)).toEqual(["2026-07-10"]);
    expect(markersOf(r).find((e) => e.date === "2026-07-10")?.paymentDueCents).toBe(100_00);
  });

  it("a Plaid statement arriving later replaces the estimate, even with drifted dates", () => {
    const input = {
      ...EMPTY,
      today: "2026-05-20",
      activeCards: [card({ plaidAccountId: "acct1" })],
      plaidAccounts: [{ id: "acct1", balanceCents: 300_00 }],
    };
    const before = projectCardPayments(input);
    expect(markersOf(before).find((e) => e.date === "2026-06-10")).toMatchObject({
      estimated: true,
      paymentDueCents: 300_00,
    });
    // The issuer's statement lands a day off the configured cycle (05-14, due
    // 06-09). It is the same closed cycle: it takes over, no estimate is left.
    const after = projectCardPayments({
      ...input,
      statements: [
        stmt({ statementDate: "2026-05-14", dueDate: "2026-06-09", statementBalanceCents: 280_00 }),
      ],
    });
    expect(markersOf(after).map((e) => [e.date, e.estimated, e.paymentDueCents])).toEqual([
      ["2026-06-09", false, 280_00],
      ["2026-07-10", true, 20_00],
    ]);
  });

  it("an unpaid statement from an EARLIER cycle is not counted twice", () => {
    // 04-15 statement ($100, due 05-10) is overdue; live balance $300. The
    // closed 05-15 cycle estimates only the rest ($200).
    const r = projectCardPayments({
      ...EMPTY,
      today: "2026-05-20",
      activeCards: [card({ currentBalanceCents: 300_00 })],
      statements: [
        stmt({ statementDate: "2026-04-15", dueDate: "2026-05-10", statementBalanceCents: 100_00 }),
      ],
    });
    expect(markersOf(r).map((e) => [e.date, e.estimated, e.paymentDueCents])).toEqual([
      ["2026-05-20", false, 100_00],
      ["2026-06-10", true, 200_00],
      ["2026-07-10", true, 200_00],
    ]);
  });

  it("merges the closed-cycle estimate into an overdue marker on its own due date", () => {
    // 04-15 statement ($100, due 05-10) is overdue; live balance $300, so the
    // closed 05-15 cycle estimates $200, due 06-10.
    const input = {
      ...EMPTY,
      activeCards: [card({ currentBalanceCents: 300_00 })],
      statements: [
        stmt({ statementDate: "2026-04-15", dueDate: "2026-05-10", statementBalanceCents: 100_00 }),
      ],
    };
    // The day before: overdue $100 rides on today, the $200 estimate on 06-10.
    const dayBefore = projectCardPayments({ ...input, today: "2026-06-09" });
    expect(markersOf(dayBefore).map((e) => [e.date, e.estimated, e.paymentDueCents])).toEqual([
      ["2026-06-09", false, 100_00],
      ["2026-06-10", true, 200_00],
      ["2026-07-10", true, 200_00],
    ]);
    // On the due date both share today's slot: one marker owing the full $300,
    // still flagged overdue; the estimate adds no issuer minimum.
    const onDue = projectCardPayments({ ...input, today: "2026-06-10" });
    const today = markersOf(onDue).filter((e) => e.date === "2026-06-10");
    expect(today).toHaveLength(1);
    expect(today[0]).toMatchObject({
      estimated: false,
      paymentDueCents: 300_00,
      paymentBalanceCents: 300_00,
      overdueSinceDate: "2026-05-10",
      paymentMinimumCents: 0,
      scheduledCoverCents: 0,
    });
    expect(markersOf(onDue).find((e) => e.date === "2026-07-10")).toMatchObject({
      estimated: true,
      paymentDueCents: 200_00,
    });
  });

  it("follows the promo guard and the headroom cap", () => {
    const withPromo = projectCardPayments({
      ...EMPTY,
      today: "2026-05-20",
      activeCards: [card({ currentBalanceCents: 300_00 })],
      promos: [promo({ remainingAmountCents: 100_00, monthlyPaymentCents: 50_00 })],
    });
    expect(markersOf(withPromo).find((e) => e.date === "2026-06-10")).toMatchObject({
      estimated: true,
      paymentDueCents: 200_00,
    });
    // Promo larger than the balance: the estimate nets to 0 → no marker at all.
    const drifted = projectCardPayments({
      ...EMPTY,
      today: "2026-05-20",
      activeCards: [card({ currentBalanceCents: 300_00 })],
      promos: [promo({ remainingAmountCents: 500_00 })],
    });
    expect(drifted.promoDriftByCard["c1"]).toBe(200_00);
    expect(markersOf(drifted)).toEqual([]);
  });

  it("a paydown aimed at the closed cycle's due date is spent once (conservation)", () => {
    // Estimate $200 on 06-10 (300 − 100 promo) + promo cash $50 on 06-10 and
    // 07-10. A $220 paydown on 05-25: 200 covers the marker, 20 trims the
    // 06-10 chunk. Cover + cash relief never exceeds the paydown.
    const r = projectCardPayments({
      ...EMPTY,
      today: "2026-05-20",
      activeCards: [card({ currentBalanceCents: 300_00 })],
      promos: [promo({ remainingAmountCents: 100_00, monthlyPaymentCents: 50_00 })],
      cardPaymentOverrides: [
        override({ dueDate: "2026-05-25", amountCents: 220_00, notes: "pays-down:2026-06-10" }),
      ],
    });
    const june = markersOf(r).find((e) => e.date === "2026-06-10");
    expect(june).toMatchObject({ estimated: true, paymentDueCents: 200_00, scheduledCoverCents: 200_00 });
    expect(cashOf(r).find((e) => e.date === "2026-06-10")?.amountCents).toBe(30_00);
    expect(cashOf(r).find((e) => e.date === "2026-07-10")?.amountCents).toBe(50_00);
    const promoRelief = 100_00 - (r.promoCashByCard["c1"] ?? 0);
    expect((june?.scheduledCoverCents ?? 0) + promoRelief).toBeLessThanOrEqual(220_00);
    expect(cashTotal(r)).toBe(220_00 + 30_00 + 50_00);
  });
});

// PROJ-4 follow-up: a MANUAL card's balance does not move when the user pays.
// A payment dated after the close and before today already went to the issuer,
// so it still covers the closed cycle's estimate while the balance has not
// been edited since. Display cover only: no cash moves, nothing else is covered.
describe("projectCardPayments — past payments cover a manual card's closed-cycle estimate", () => {
  const paid = (amountCents: number, dueDate = "2026-06-05") =>
    override({ dueDate, amountCents, notes: "pays-down:2026-06-10" });
  const base = (over: Partial<Parameters<typeof projectCardPayments>[0]> = {}) =>
    projectCardPayments({
      ...EMPTY,
      today: "2026-06-06",
      activeCards: [card({ currentBalanceCents: 300_00 })],
      cardEditedOnByCard: new Map([["c1", "2026-06-01"]]),
      cardPaymentOverrides: [paid(300_00)],
      ...over,
    });
  const june = (r: Result) => markersOf(r).find((e) => e.date === "2026-06-10");
  const alertOn = (r: Result, today: string) =>
    findUncoveredCardDues(
      computeProjection({
        startingBalanceCents: 1000_00,
        startDate: today,
        endDate: "2026-08-01",
        paychecks: [],
        bills: [],
        extras: r.extras,
      }),
      { today, horizonDays: 14 },
    );

  it("an early payment covers the closed cycle: no alert the day after paying", () => {
    const r = base();
    expect(june(r)).toMatchObject({ estimated: true, paymentDueCents: 300_00, scheduledCoverCents: 300_00 });
    expect(alertOn(r, "2026-06-06")).toEqual([]);
    // Only the closed-cycle marker: the next cycle's run rate is not covered.
    expect(markersOf(r).find((e) => e.date === "2026-07-10")?.scheduledCoverCents).toBe(0);
    // No new cash: the only card cash is the plan's own past-dated row, which
    // the projection drops (dated before today).
    expect(cashOf(r).filter((e) => e.date >= "2026-06-06")).toEqual([]);
  });

  it("a balance edited to $0 after the payment leaves no marker", () => {
    const r = base({
      activeCards: [card({ currentBalanceCents: 0 })],
      cardEditedOnByCard: new Map([["c1", "2026-06-07"]]),
      today: "2026-06-07",
    });
    expect(markersOf(r)).toEqual([]);
  });

  it("a balance edited after the payment is the truth: the payment no longer counts", () => {
    const r = base({
      activeCards: [card({ currentBalanceCents: 120_00 })],
      cardEditedOnByCard: new Map([["c1", "2026-06-07"]]),
      today: "2026-06-07",
    });
    expect(june(r)).toMatchObject({ paymentDueCents: 120_00, scheduledCoverCents: 0 });
    // An edit on the payment day itself is ambiguous: fail toward showing the due.
    const sameDay = base({ cardEditedOnByCard: new Map([["c1", "2026-06-05"]]) });
    expect(june(sameDay)?.scheduledCoverCents).toBe(0);
    // No edit date known: no past cover.
    const unknown = base({ cardEditedOnByCard: undefined });
    expect(june(unknown)?.scheduledCoverCents).toBe(0);
  });

  it("never applies to a Plaid-linked card (its balance already reflects payments)", () => {
    const r = base({
      activeCards: [card({ plaidAccountId: "acct1" })],
      plaidAccounts: [{ id: "acct1", balanceCents: 300_00 }],
    });
    expect(june(r)).toMatchObject({ paymentDueCents: 300_00, scheduledCoverCents: 0 });
  });

  it("a payment dated on or before the close paid an earlier cycle", () => {
    for (const date of ["2026-05-14", "2026-05-15"]) {
      const r = base({ cardPaymentOverrides: [paid(300_00, date)] });
      expect(june(r)?.scheduledCoverCents).toBe(0);
    }
  });

  it("a partial early payment leaves the rest uncovered", () => {
    const r = base({ cardPaymentOverrides: [paid(100_00)] });
    expect(june(r)).toMatchObject({ paymentDueCents: 300_00, scheduledCoverCents: 100_00 });
    expect(alertOn(r, "2026-06-06")).toMatchObject([{ dueDate: "2026-06-10", shortfallCents: 200_00 }]);
  });

  it("plain and over-sized past payments count, capped at what the marker owes", () => {
    const r = base({
      cardPaymentOverrides: [
        override({ id: "o1", dueDate: "2026-05-20", amountCents: 250_00, notes: null }),
        paid(250_00),
      ],
    });
    expect(june(r)).toMatchObject({ paymentDueCents: 300_00, scheduledCoverCents: 300_00 });
  });

  it("an in-flight tracked plan is counted once: unposted part as today, posted part as past", () => {
    // $150 plan dated 06-05, $100 of it posted, $50 still in flight.
    const r = base({
      cardPaymentOverrides: [paid(150_00)],
      remainingPlannedCentsByKey: new Map([["c1:2026-06-05", 50_00]]),
    });
    expect(june(r)?.scheduledCoverCents).toBe(150_00);
    // Not posted at all: the existing in-flight rule covers it, nothing extra.
    const unposted = base({
      cardPaymentOverrides: [paid(150_00)],
      remainingPlannedCentsByKey: new Map([["c1:2026-06-05", 150_00]]),
    });
    expect(june(unposted)?.scheduledCoverCents).toBe(150_00);
  });
});
