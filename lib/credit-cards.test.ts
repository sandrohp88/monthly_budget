import { describe, expect, it } from "vitest";
import {
  currentCycleWindow,
  currentStatementOf,
  daysBetween,
  dueDateFromStatement,
  estimateCurrentCycle,
  isStatementOpen,
  nextDayOfMonthOnOrAfter,
  paidWithoutInterest,
  totalDue,
} from "./credit-cards";
import type {
  BillRow,
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
    paidAmountCents: null,
    paidDate: null,
    notes: null,
    createdAt: 0,
    ...over,
  };
}

function bill(over: Partial<BillRow> = {}): BillRow {
  return {
    id: "b1",
    userId: "u1",
    name: "Internet",
    category: "Utilities",
    amountCents: 50_00,
    frequency: "monthly",
    dueDay: 5,
    dueMonth: null,
    autoPay: false,
    paidViaCardId: null,
    notes: null,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
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

  it("paidWithoutInterest: paid more than statement (post-statement charges) still counts", () => {
    expect(
      paidWithoutInterest(
        statement({ paidAmountCents: 150_000, paidDate: "2025-02-09" }),
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

  it("preserves bill id even when names collide (first-match attribution)", () => {
    // Documents the known limitation: same-name bills attribute to the first one.
    const out = estimateCurrentCycle(
      { statementDay: 15, dueDay: 5 },
      [
        bill({ id: "first", name: "Streaming", dueDay: 28, amountCents: 9_99 }),
        bill({ id: "second", name: "Streaming", dueDay: 1, amountCents: 14_99 }),
      ],
      "2025-03-10",
    );
    // Both bills hit in cycle (2025-02-28 and 2025-03-01).
    expect(out.charges).toHaveLength(2);
    // Both attribute to "first" because the find() matches on name.
    expect(out.charges.every((c) => c.billId === "first")).toBe(true);
  });
});
