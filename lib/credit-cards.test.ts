import { describe, expect, it } from "vitest";
import {
  cardPromoWhatIf,
  currentCycleWindow,
  currentStatementOf,
  daysBetween,
  dueDateFromStatement,
  estimateCurrentCycle,
  isStatementOpen,
  nextDayOfMonthOnOrAfter,
  nextStatementDateOnOrAfter,
  paidWithoutInterest,
  previousStatementDateOnOrBefore,
  projectPromoSchedule,
  promoMonthlyChunkAt,
  promoWhatIf,
  summarizeStatementBalances,
  totalDue,
} from "./credit-cards";
import type {
  BillRow,
  CreditCardPromoRow,
  CreditCardStatementRow,
} from "./db/schema";

// ── fixtures ────────────────────────────────────────────────────────────────

function statement(over: Partial<CreditCardStatementRow> = {}): CreditCardStatementRow {
  return {
    id: "s1",
    cardId: "c1",
    statementDate: "2025-01-15",
    dueDate: "2025-02-10",
    statementBalanceCents: 100_000, // $1,000
    minimumPaymentCents: null,
    paidAmountCents: null,
    paidDate: null,
    notes: null,
    createdAt: 0,
    ...over,
  };
}

// Tests still construct fixtures by day-of-month. Translate `dueDay` to a
// January 2024 anchor (Jan has 31 days, so every dueDay 1-31 is representable
// without clamping).
function bill(over: Partial<BillRow> & { dueDay?: number } = {}): BillRow {
  const { dueDay, ...rest } = over;
  return {
    id: "b1",
    userId: "u1",
    name: "Internet",
    category: "Utilities",
    amountCents: 50_00,
    intervalMonths: 1,
    anchorDate: dueDay != null ? `2024-01-${String(dueDay).padStart(2, "0")}` : "2024-01-05",
    autoPay: false,
    paidViaCardId: null,
    notes: null,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    ...rest,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// nextDayOfMonthOnOrAfter
// ────────────────────────────────────────────────────────────────────────────
describe("nextDayOfMonthOnOrAfter", () => {
  it("returns the same month's date when the day is on or after fromIso", () => {
    expect(nextDayOfMonthOnOrAfter("2025-03-10", 15)).toBe("2025-03-15");
    expect(nextDayOfMonthOnOrAfter("2025-03-15", 15)).toBe("2025-03-15");
  });

  it("rolls into the next month when the day has already passed", () => {
    expect(nextDayOfMonthOnOrAfter("2025-03-20", 5)).toBe("2025-04-05");
  });

  it("rolls into the next year from December", () => {
    expect(nextDayOfMonthOnOrAfter("2025-12-20", 5)).toBe("2026-01-05");
  });

  it("clamps day-31 in months with fewer days (Feb non-leap)", () => {
    expect(nextDayOfMonthOnOrAfter("2025-02-01", 31)).toBe("2025-02-28");
  });

  it("clamps day-31 in February of a leap year", () => {
    expect(nextDayOfMonthOnOrAfter("2024-02-01", 31)).toBe("2024-02-29");
  });

  it("clamps day-31 in 30-day months (April)", () => {
    expect(nextDayOfMonthOnOrAfter("2025-04-15", 31)).toBe("2025-04-30");
  });

  it("rolls past Feb when fromDay > clamped day", () => {
    // fromDay=29 in Feb non-leap, looking for day 31 → clampDay=28 < 29, roll to March.
    expect(nextDayOfMonthOnOrAfter("2025-02-29" as string, 31)).toBe("2025-03-31");
    // (Note: parser is lenient — that's a test of the rollover branch, not real input.)
  });
});

// ────────────────────────────────────────────────────────────────────────────
// dueDateFromStatement
// ────────────────────────────────────────────────────────────────────────────
describe("dueDateFromStatement", () => {
  it("places the due date at least 14 days after the statement", () => {
    const due = dueDateFromStatement("2025-01-15", 5);
    // earliest = 2025-01-29; next 5th = 2025-02-05
    expect(due).toBe("2025-02-05");
    expect(daysBetween("2025-01-15", due)).toBeGreaterThanOrEqual(14);
  });

  it("uses the same-month dueDay if it falls in the grace window", () => {
    expect(dueDateFromStatement("2025-01-15", 31)).toBe("2025-01-31");
  });

  it("rolls forward when the dueDay has already passed in the next month after grace", () => {
    // Statement Jan 25 → earliest Feb 8 → next 5th = Mar 5.
    expect(dueDateFromStatement("2025-01-25", 5)).toBe("2025-03-05");
  });

  it("clamps a high dueDay against shorter months", () => {
    // Feb 28 statement, dueDay 31 → earliest Mar 14 → Mar 31.
    expect(dueDateFromStatement("2025-02-28", 31)).toBe("2025-03-31");
    // Feb 14 statement, dueDay 31 → earliest Feb 28 → Feb 28 (clamped) — only 14 days, but
    // that matches the contract: "next occurrence ≥ 14 days out, clamped to month length".
    expect(dueDateFromStatement("2025-02-14", 31)).toBe("2025-02-28");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// paidWithoutInterest / isStatementOpen / totalDue
// ────────────────────────────────────────────────────────────────────────────
describe("statement payment state", () => {
  it("isStatementOpen treats null paidAmountCents as open", () => {
    expect(isStatementOpen(statement())).toBe(true);
    expect(isStatementOpen(statement({ paidAmountCents: 0 }))).toBe(false);
    expect(isStatementOpen(statement({ paidAmountCents: 100_000 }))).toBe(false);
  });

  it("isStatementOpen treats zero due statements as closed without payment", () => {
    expect(
      isStatementOpen(
        statement({
          statementBalanceCents: 0,
          minimumPaymentCents: 0,
          paidAmountCents: null,
          paidDate: null,
        }),
      ),
    ).toBe(false);
  });

  it("paidWithoutInterest: paid in full, on or before due → true", () => {
    expect(
      paidWithoutInterest(
        statement({ paidAmountCents: 100_000, paidDate: "2025-02-10" }),
      ),
    ).toBe(true);
    expect(
      paidWithoutInterest(
        statement({ paidAmountCents: 100_000, paidDate: "2025-02-09" }),
      ),
    ).toBe(true);
  });

  it("paidWithoutInterest: paid in full but late → false", () => {
    expect(
      paidWithoutInterest(
        statement({ paidAmountCents: 100_000, paidDate: "2025-02-11" }),
      ),
    ).toBe(false);
  });

  it("paidWithoutInterest: partial payment on time → false", () => {
    expect(
      paidWithoutInterest(
        statement({ paidAmountCents: 50_000, paidDate: "2025-02-10" }),
      ),
    ).toBe(false);
  });

  it("paidWithoutInterest: never marked paid → false", () => {
    expect(paidWithoutInterest(statement())).toBe(false);
  });

  it("paidWithoutInterest: zero due statements are fee-safe without a payment", () => {
    expect(
      paidWithoutInterest(
        statement({
          statementBalanceCents: 0,
          minimumPaymentCents: null,
          paidAmountCents: null,
          paidDate: null,
        }),
      ),
    ).toBe(true);
  });

  it("paidWithoutInterest: paid more than statement (post-statement charges) still counts", () => {
    expect(
      paidWithoutInterest(
        statement({ paidAmountCents: 150_000, paidDate: "2025-02-09" }),
      ),
    ).toBe(true);
  });

  it("paidWithoutInterest: zero statement balance can use the Plaid minimum payment", () => {
    expect(
      paidWithoutInterest(
        statement({
          statementBalanceCents: 0,
          minimumPaymentCents: 35_00,
          paidAmountCents: 35_00,
          paidDate: "2025-02-10",
        }),
      ),
    ).toBe(true);
  });

  it("totalDue sums only unpaid statements", () => {
    const a = statement({ id: "a", statementBalanceCents: 100_000 });
    const b = statement({
      id: "b",
      statementBalanceCents: 50_000,
      paidAmountCents: 50_000,
      paidDate: "2025-02-10",
    });
    const c = statement({ id: "c", statementBalanceCents: 25_000 });
    expect(totalDue([a, b, c])).toBe(125_000);
    expect(totalDue([])).toBe(0);
  });

  it("totalDue uses a minimum payment when Plaid reports a zero statement balance", () => {
    const a = statement({
      id: "a",
      statementBalanceCents: 0,
      minimumPaymentCents: 35_00,
    });
    const b = statement({
      id: "b",
      statementBalanceCents: 0,
      minimumPaymentCents: 35_00,
      paidAmountCents: 35_00,
      paidDate: "2025-02-10",
    });
    expect(totalDue([a, b])).toBe(35_00);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// currentStatementOf
// ────────────────────────────────────────────────────────────────────────────
describe("currentStatementOf", () => {
  it("returns undefined when there are no statements", () => {
    expect(currentStatementOf([])).toBeUndefined();
  });

  it("prefers the earliest unpaid statement (by due date)", () => {
    const a = statement({ id: "a", dueDate: "2025-03-10" });
    const b = statement({ id: "b", dueDate: "2025-02-10" });
    const c = statement({ id: "c", dueDate: "2025-04-10" });
    expect(currentStatementOf([a, b, c])?.id).toBe("b");
  });

  it("falls back to the most recent paid when all are paid", () => {
    const a = statement({
      id: "a",
      statementDate: "2025-01-15",
      paidAmountCents: 100_000,
      paidDate: "2025-02-10",
    });
    const b = statement({
      id: "b",
      statementDate: "2025-02-15",
      paidAmountCents: 100_000,
      paidDate: "2025-03-10",
    });
    expect(currentStatementOf([a, b])?.id).toBe("b");
  });

  it("ignores paid statements when at least one is unpaid", () => {
    const paid = statement({
      id: "p",
      statementDate: "2025-03-15",
      paidAmountCents: 100_000,
      paidDate: "2025-04-01",
    });
    const unpaid = statement({ id: "u", dueDate: "2025-02-10" });
    expect(currentStatementOf([paid, unpaid])?.id).toBe("u");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// daysBetween (lib/credit-cards.ts version)
// ────────────────────────────────────────────────────────────────────────────
describe("credit-cards daysBetween", () => {
  it("returns the count of days between two ISO dates", () => {
    expect(daysBetween("2025-01-01", "2025-01-08")).toBe(7);
    expect(daysBetween("2025-01-08", "2025-01-01")).toBe(-7);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2); // includes leap day
  });
});

// ────────────────────────────────────────────────────────────────────────────
// summarizeStatementBalances
// ────────────────────────────────────────────────────────────────────────────
describe("summarizeStatementBalances", () => {
  const today = "2025-12-15";
  const stmts: CreditCardStatementRow[] = [
    statement({ id: "a", statementDate: "2025-12-01", statementBalanceCents: 600_00 }),
    statement({ id: "b", statementDate: "2025-11-01", statementBalanceCents: 500_00 }),
    statement({ id: "c", statementDate: "2025-10-01", statementBalanceCents: 400_00 }),
    statement({ id: "d", statementDate: "2025-07-01", statementBalanceCents: 700_00 }),
    statement({ id: "e", statementDate: "2025-01-01", statementBalanceCents: 200_00 }),
    statement({ id: "f", statementDate: "2024-11-01", statementBalanceCents: 999_00 }), // outside 12mo
  ];

  it("returns the most recent closed statement for last-stmt", () => {
    const s = summarizeStatementBalances(stmts, today);
    expect(s.lastClosedDate).toBe("2025-12-01");
    expect(s.lastClosedCents).toBe(600_00);
  });

  it("computes 3/6/12 month averages over their respective windows", () => {
    const s = summarizeStatementBalances(stmts, today);
    // 3M window: > 2025-09-15 — includes a, b, c
    expect(s.avg3MoCount).toBe(3);
    expect(s.avg3MoCents).toBe(Math.round((600_00 + 500_00 + 400_00) / 3));
    // 6M window: > 2025-06-15 — includes a, b, c, d
    expect(s.avg6MoCount).toBe(4);
    expect(s.avg6MoCents).toBe(Math.round((600_00 + 500_00 + 400_00 + 700_00) / 4));
    // 12M window: > 2024-12-15 — includes a, b, c, d, e (f is outside)
    expect(s.avg12MoCount).toBe(5);
    expect(s.avg12MoCents).toBe(Math.round((600_00 + 500_00 + 400_00 + 700_00 + 200_00) / 5));
  });

  it("ignores statements that close after asOfIso (future)", () => {
    const future = statement({ id: "fut", statementDate: "2026-01-01", statementBalanceCents: 9_999_00 });
    const s = summarizeStatementBalances([future, ...stmts], today);
    expect(s.lastClosedDate).toBe("2025-12-01");
    expect(s.avg3MoCount).toBe(3);
  });

  it("returns nulls and zero counts when no statements fall in any window", () => {
    const s = summarizeStatementBalances([], today);
    expect(s.lastClosedCents).toBeNull();
    expect(s.lastClosedDate).toBeNull();
    expect(s.avg3MoCents).toBeNull();
    expect(s.avg3MoCount).toBe(0);
    expect(s.avg6MoCents).toBeNull();
    expect(s.avg12MoCents).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// currentCycleWindow
// ────────────────────────────────────────────────────────────────────────────
describe("currentCycleWindow", () => {
  it("for statementDay 15, returns prevClose+1 → next 15th", () => {
    expect(currentCycleWindow({ statementDay: 15 }, "2025-03-10")).toEqual({
      start: "2025-02-16",
      end: "2025-03-15",
    });
  });

  it("when fromIso is exactly the statement day, the cycle ends today", () => {
    expect(currentCycleWindow({ statementDay: 15 }, "2025-03-15")).toEqual({
      start: "2025-02-16",
      end: "2025-03-15",
    });
  });

  it("statementDay 31 in Feb (non-leap) clamps end to Feb 28", () => {
    expect(currentCycleWindow({ statementDay: 31 }, "2025-02-15")).toEqual({
      start: "2025-02-01",
      end: "2025-02-28",
    });
  });

  it("statementDay 31 in Feb (leap) clamps end to Feb 29", () => {
    expect(currentCycleWindow({ statementDay: 31 }, "2024-02-15")).toEqual({
      start: "2024-02-01",
      end: "2024-02-29",
    });
  });

  it("statementDay 5 in early January rolls prevClose into December of previous year", () => {
    expect(currentCycleWindow({ statementDay: 5 }, "2025-01-10")).toEqual({
      start: "2025-01-06",
      end: "2025-02-05",
    });
  });

  it("the start is always the day after the previous close (no gaps, no overlap)", () => {
    const win = currentCycleWindow({ statementDay: 15 }, "2025-06-20");
    // start should be exactly +1 day after the statement-day of the prev month
    expect(win.start).toBe("2025-06-16");
    expect(win.end).toBe("2025-07-15");
  });

  it("supports a 31-day statement cycle anchored to a known statement date", () => {
    const card = {
      statementDay: 15,
      statementCycleMode: "interval_days",
      statementCycleAnchorDate: "2025-01-15",
      statementCycleIntervalDays: 31,
    } as const;

    expect(nextStatementDateOnOrAfter("2025-02-10", card)).toBe("2025-02-15");
    expect(nextStatementDateOnOrAfter("2025-02-16", card)).toBe("2025-03-18");
    expect(previousStatementDateOnOrBefore("2025-02-16", card)).toBe("2025-02-15");
    expect(currentCycleWindow(card, "2025-03-10")).toEqual({
      start: "2025-02-16",
      end: "2025-03-18",
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// estimateCurrentCycle
// ────────────────────────────────────────────────────────────────────────────
describe("estimateCurrentCycle", () => {
  it("returns an empty result when no bills are linked", () => {
    const out = estimateCurrentCycle({ statementDay: 15, dueDay: 5 }, [], "2025-03-10");
    expect(out.window).toEqual({ start: "2025-02-16", end: "2025-03-15" });
    expect(out.charges).toEqual([]);
    expect(out.totalCents).toBe(0);
  });

  it("counts a bill that lands inside the cycle window", () => {
    // Cycle: 2025-02-16 → 2025-03-15. Bill on day 5 → 2025-03-05 is inside.
    const out = estimateCurrentCycle(
      { statementDay: 15, dueDay: 5 },
      [bill({ name: "Internet", amountCents: 75_00, dueDay: 5 })],
      "2025-03-10",
    );
    expect(out.charges).toHaveLength(1);
    expect(out.charges[0]).toMatchObject({
      billId: "b1",
      name: "Internet",
      date: "2025-03-05",
      amountCents: 75_00,
    });
    expect(out.totalCents).toBe(75_00);
  });

  it("excludes a bill that falls outside the cycle window", () => {
    // Cycle: 2025-02-16 → 2025-03-15. Bill on day 25 → 2025-02-25 is inside,
    // but a bill on day 20 → 2025-02-20 is also inside; day 25 in next month
    // (2025-03-25) is OUTSIDE the cycle (after end). Use day 16 → 2025-02-16
    // is inside; day 15 → 2025-02-15 is BEFORE start = excluded.
    const out = estimateCurrentCycle(
      { statementDay: 15, dueDay: 5 },
      [bill({ name: "Earlybird", dueDay: 15, amountCents: 10_00 })],
      "2025-03-10",
    );
    // Day 15 of cycle months: 2025-02-15 (before start 02-16) and 2025-03-15
    // (== end, included). So 1 charge expected.
    expect(out.charges).toHaveLength(1);
    expect(out.charges[0]?.date).toBe("2025-03-15");
  });

  it("handles multiple bills with distinct dates", () => {
    const out = estimateCurrentCycle(
      { statementDay: 15, dueDay: 5 },
      [
        bill({ id: "b1", name: "Internet", dueDay: 5, amountCents: 75_00 }),
        bill({ id: "b2", name: "Streaming", dueDay: 28, amountCents: 12_99 }),
      ],
      "2025-03-10",
    );
    // Cycle: 2025-02-16 → 2025-03-15
    // Internet 5th → 2025-03-05 (inside)
    // Streaming 28th → 2025-02-28 (inside)
    expect(out.charges).toHaveLength(2);
    expect(out.totalCents).toBe(87_99);
  });

  it("crosses a year boundary cleanly (Dec→Jan cycle)", () => {
    // Cycle: 2024-12-16 → 2025-01-15
    const out = estimateCurrentCycle(
      { statementDay: 15, dueDay: 5 },
      [bill({ name: "Internet", dueDay: 5, amountCents: 50_00 })],
      "2025-01-10",
    );
    expect(out.window).toEqual({ start: "2024-12-16", end: "2025-01-15" });
    expect(out.charges).toHaveLength(1);
    expect(out.charges[0]?.date).toBe("2025-01-05");
  });

  it("estimates linked bills inside an interval-day statement cycle", () => {
    const out = estimateCurrentCycle(
      {
        statementDay: 15,
        statementCycleMode: "interval_days",
        statementCycleAnchorDate: "2025-01-15",
        statementCycleIntervalDays: 31,
        dueDay: 10,
      },
      [bill({ name: "Internet", dueDay: 5, amountCents: 50_00 })],
      "2025-03-10",
    );

    expect(out.window).toEqual({ start: "2025-02-16", end: "2025-03-18" });
    expect(out.charges).toHaveLength(1);
    expect(out.charges[0]?.date).toBe("2025-03-05");
  });

  it("attributes same-name bills to their own ids (sourceId, not name match)", () => {
    const out = estimateCurrentCycle(
      { statementDay: 15, dueDay: 5 },
      [
        bill({ id: "first", name: "Streaming", dueDay: 28, amountCents: 9_99 }),
        bill({ id: "second", name: "Streaming", dueDay: 1, amountCents: 14_99 }),
      ],
      "2025-03-10",
    );
    // Both bills hit in cycle (2025-02-28 and 2025-03-01), each under its own id.
    expect(out.charges).toHaveLength(2);
    expect(out.charges.map((c) => [c.billId, c.amountCents])).toEqual([
      ["first", 9_99],
      ["second", 14_99],
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Promotional financing
// ────────────────────────────────────────────────────────────────────────────

function promo(over: Partial<CreditCardPromoRow> = {}): CreditCardPromoRow {
  return {
    id: "p1",
    userId: "u1",
    cardId: "c1",
    description: "Test promo",
    originalAmountCents: 120_000, // $1,200
    remainingAmountCents: 120_000,
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    monthlyPaymentCents: null,
    notes: null,
    isActive: true,
    authoritativeSource: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe("promoMonthlyChunkAt", () => {
  it("uses the override when set, clamped to remaining", () => {
    const p = promo({ monthlyPaymentCents: 50_00, remainingAmountCents: 30_00 });
    expect(promoMonthlyChunkAt(p, "2026-03-01")).toBe(30_00);
  });

  it("computes ceil(remaining/months_left) when no override", () => {
    // 12 months remaining (Jan 2026 → Dec 2026 inclusive), $1200 → exactly $100/mo
    const p = promo({ remainingAmountCents: 120_00 });
    expect(promoMonthlyChunkAt(p, "2026-01-01")).toBe(10_00);
  });

  it("recomputes as remaining decreases month-over-month", () => {
    // After 6 payments of $100, remaining = $600 with 6 months left → still $100
    const p = promo({ remainingAmountCents: 60_00 });
    expect(promoMonthlyChunkAt(p, "2026-07-01")).toBe(10_00);
  });

  it("returns the full remaining as a lump after endDate", () => {
    const p = promo({ remainingAmountCents: 30_00 });
    expect(promoMonthlyChunkAt(p, "2027-01-15")).toBe(30_00);
  });

  it("returns zero when remaining is zero", () => {
    expect(promoMonthlyChunkAt(promo({ remainingAmountCents: 0 }), "2026-05-01")).toBe(0);
  });
});

describe("projectPromoSchedule", () => {
  const card = { statementDay: 15, dueDay: 10 };

  it("starts with the card's next due day in the current cycle", () => {
    const schedule = projectPromoSchedule(
      promo({
        remainingAmountCents: 60_00,
        startDate: "2026-05-01",
        endDate: "2026-08-31",
        monthlyPaymentCents: 20_00,
      }),
      card,
      "2026-05-03",
      new Set(),
    );
    expect(schedule[0]).toEqual({ dueDate: "2026-05-10", amountCents: 20_00 });
  });

  it("uses the promo deadline when it arrives before the current cycle due day", () => {
    const schedule = projectPromoSchedule(
      promo({
        remainingAmountCents: 25_00,
        startDate: "2026-05-04",
        endDate: "2026-05-08",
        monthlyPaymentCents: 30_00,
      }),
      card,
      "2026-05-04",
      new Set(),
    );
    expect(schedule).toEqual([{ dueDate: "2026-05-08", amountCents: 25_00 }]);
  });

  it("schedules monthly chunks landing on each due date through endDate", () => {
    const schedule = projectPromoSchedule(
      promo({ remainingAmountCents: 60_00, startDate: "2026-05-01", endDate: "2026-10-31" }),
      card,
      "2026-05-03",
      new Set(),
    );
    // Cycles: stmt May 15 → due ~Jun 10, stmt Jun 15 → Jul 10, … stmt Oct 15 → Nov 10
    // Final due (Nov 10) is past endDate (Oct 31) so it gets the lump-on-cliff branch
    expect(schedule.length).toBeGreaterThan(0);
    const total = schedule.reduce((s, c) => s + c.amountCents, 0);
    expect(total).toBe(60_00); // sums to the full remaining
  });

  it("skips cycles whose due date is in the skip set (recorded statements)", () => {
    const skip = new Set(["2026-06-10"]);
    const schedule = projectPromoSchedule(
      promo({ remainingAmountCents: 30_00, startDate: "2026-05-01", endDate: "2026-08-31" }),
      card,
      "2026-05-03",
      skip,
    );
    expect(schedule.find((c) => c.dueDate === "2026-06-10")).toBeUndefined();
    // Other due dates should still appear
    expect(schedule.length).toBeGreaterThan(0);
  });

  it("returns empty for archived promos", () => {
    const schedule = projectPromoSchedule(
      promo({ isActive: false }),
      card,
      "2026-05-01",
      new Set(),
    );
    expect(schedule).toEqual([]);
  });

  it("returns empty when remaining is zero", () => {
    const schedule = projectPromoSchedule(
      promo({ remainingAmountCents: 0 }),
      card,
      "2026-05-01",
      new Set(),
    );
    expect(schedule).toEqual([]);
  });

  it("uses manual scheduled payments verbatim when present", () => {
    const schedule = projectPromoSchedule(
      promo({
        remainingAmountCents: 60_00,
        startDate: "2026-05-01",
        endDate: "2026-12-31",
      }),
      card,
      "2026-05-03",
      new Set(),
      [
        { dueDate: "2026-06-15", amountCents: 25_00 },
        { dueDate: "2026-08-15", amountCents: 35_00 },
      ],
    );
    expect(schedule).toEqual([
      { dueDate: "2026-06-15", amountCents: 25_00 },
      { dueDate: "2026-08-15", amountCents: 35_00 },
    ]);
  });

  it("manual schedule filters out past payments before fromIso", () => {
    const schedule = projectPromoSchedule(
      promo({ remainingAmountCents: 100_00, endDate: "2027-12-31" }),
      card,
      "2026-06-10",
      new Set(),
      [
        { dueDate: "2026-05-01", amountCents: 20_00 },
        { dueDate: "2026-07-15", amountCents: 80_00 },
      ],
    );
    expect(schedule).toEqual([{ dueDate: "2026-07-15", amountCents: 80_00 }]);
  });

  it("manual schedule still respects skipDueDates (recorded statements)", () => {
    const schedule = projectPromoSchedule(
      promo({ remainingAmountCents: 60_00, endDate: "2027-12-31" }),
      card,
      "2026-05-01",
      new Set(["2026-06-10"]),
      [
        { dueDate: "2026-06-10", amountCents: 30_00 },
        { dueDate: "2026-07-10", amountCents: 30_00 },
      ],
    );
    expect(schedule).toEqual([{ dueDate: "2026-07-10", amountCents: 30_00 }]);
  });

  it("manual schedule short-circuits the auto-spread end-date lump", () => {
    // Manual rows total less than remaining → projection just uses what's
    // there. No "force the rest onto endDate" lump like auto-spread does.
    const schedule = projectPromoSchedule(
      promo({ remainingAmountCents: 100_00, endDate: "2026-12-31" }),
      card,
      "2026-01-01",
      new Set(),
      [{ dueDate: "2026-06-01", amountCents: 25_00 }],
    );
    expect(schedule).toEqual([{ dueDate: "2026-06-01", amountCents: 25_00 }]);
    const total = schedule.reduce((s, c) => s + c.amountCents, 0);
    expect(total).toBe(25_00);
  });

  it("never schedules a chunk after the promo endDate", () => {
    // Cycles whose due date falls past `endDate` collapse to a single lump
    // on `endDate` itself, not on the post-deadline cycle. This makes the
    // cliff visualize on the actual interest-free deadline.
    const schedule = projectPromoSchedule(
      promo({ remainingAmountCents: 60_00, startDate: "2026-05-01", endDate: "2026-10-31" }),
      card,
      "2026-05-03",
      new Set(),
    );
    expect(schedule.length).toBeGreaterThan(0);
    for (const chunk of schedule) {
      expect(chunk.dueDate <= "2026-10-31").toBe(true);
    }
  });

  it("converges to zero by the deadline (no overshoot, no shortfall)", () => {
    // Awkward number — $1,001 over 7 months: ceil($1001/7)=$143; the schedule
    // should still sum to exactly $1,001, with the final chunk absorbing the
    // rounding remainder.
    const schedule = projectPromoSchedule(
      promo({ remainingAmountCents: 1001_00, startDate: "2026-05-01", endDate: "2026-11-30" }),
      card,
      "2026-05-03",
      new Set(),
    );
    const total = schedule.reduce((s, c) => s + c.amountCents, 0);
    expect(total).toBe(1001_00);
  });
});

describe("promoWhatIf", () => {
  const card = { statementDay: 15, dueDay: 10 };

  it("payOffNow always equals the remaining balance, today's date", () => {
    const w = promoWhatIf(
      promo({ remainingAmountCents: 80_00 }),
      card,
      "2026-05-03",
    );
    expect(w.payOffNow.totalCents).toBe(80_00);
    expect(w.payOffNow.cashOutDate).toBe("2026-05-03");
  });

  it("continueSchedule sums to the same remaining balance", () => {
    const w = promoWhatIf(
      promo({ remainingAmountCents: 80_00, startDate: "2026-05-01", endDate: "2026-08-31" }),
      card,
      "2026-05-03",
    );
    expect(w.continueSchedule.totalCents).toBe(80_00);
    expect(w.continueSchedule.chunks.length).toBeGreaterThan(0);
  });
});

describe("cardPromoWhatIf", () => {
  const card = { statementDay: 15, dueDay: 10 };

  it("merges chunks from multiple promos landing on the same due date", () => {
    const a = promo({
      id: "a",
      remainingAmountCents: 30_00,
      startDate: "2026-05-01",
      endDate: "2026-07-31",
      monthlyPaymentCents: 10_00,
    });
    const b = promo({
      id: "b",
      remainingAmountCents: 60_00,
      startDate: "2026-05-01",
      endDate: "2026-07-31",
      monthlyPaymentCents: 20_00,
    });
    const w = cardPromoWhatIf([a, b], card, "2026-05-03");
    // Pay-off-now = 30 + 60 = 90
    expect(w.payOffNow.totalCents).toBe(90_00);
    // Total scheduled also = 90
    expect(w.continueSchedule.totalCents).toBe(90_00);
    // Each due date entry should be the SUM of both promos' chunks (10+20=30)
    for (const chunk of w.continueSchedule.chunks) {
      expect(chunk.amountCents).toBe(30_00);
    }
  });

  it("excludes archived and zero-balance promos", () => {
    const a = promo({ id: "a", isActive: false, remainingAmountCents: 50_00 });
    const b = promo({ id: "b", remainingAmountCents: 0 });
    const c = promo({ id: "c", remainingAmountCents: 40_00 });
    const w = cardPromoWhatIf([a, b, c], card, "2026-05-03");
    expect(w.payOffNow.totalCents).toBe(40_00);
  });
});
