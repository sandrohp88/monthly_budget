import { describe, expect, it } from "vitest";
import {
  calculateMonthlyHistoryAverage,
  projectVariableBillCardCharges,
} from "./variable-bills";
import type { CreditCardRow, VariableBillRow } from "./db/schema";

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

function variableBill(over: Partial<VariableBillRow> = {}): VariableBillRow {
  return {
    id: "v1",
    userId: "u1",
    name: "Groceries",
    category: "Food",
    amountCents: 600_00,
    intervalMonths: 1,
    anchorDate: "2026-05-05",
    notes: null,
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe("calculateMonthlyHistoryAverage", () => {
  it("averages over the full lookback window, including zero-spend months", () => {
    const avg = calculateMonthlyHistoryAverage(
      [
        { date: "2026-03-10", amountCents: 120_00 },
        { date: "2026-05-02", amountCents: 60_00 },
      ],
      "2026-05-07",
      3,
    );

    expect(avg.totalCents).toBe(180_00);
    expect(avg.averageCents).toBe(60_00);
    expect(avg.sampleCount).toBe(2);
    expect(avg.monthlyTotals).toEqual([
      { month: "2026-03", amountCents: 120_00 },
      { month: "2026-04", amountCents: 0 },
      { month: "2026-05", amountCents: 60_00 },
    ]);
  });
});

describe("projectVariableBillCardCharges", () => {
  it("splits a variable bill across linked active cards and lands cash on statement due dates", () => {
    const charges = projectVariableBillCardCharges({
      variableBills: [
        {
          ...variableBill({ amountCents: 100_01 }),
          cardIds: ["c1", "c2"],
        },
      ],
      cards: [
        card({ id: "c1", name: "One", statementDay: 15, dueDay: 10 }),
        card({ id: "c2", name: "Two", statementDay: 20, dueDay: 12 }),
      ],
      startDate: "2026-05-01",
      endDate: "2026-05-31",
    });

    expect(charges).toEqual([
      {
        variableBillId: "v1",
        cardId: "c1",
        name: "Groceries",
        category: "Food",
        date: "2026-05-05",
        dueDate: "2026-06-10",
        amountCents: 5001,
      },
      {
        variableBillId: "v1",
        cardId: "c2",
        name: "Groceries",
        category: "Food",
        date: "2026-05-05",
        dueDate: "2026-06-12",
        amountCents: 5000,
      },
    ]);
  });
});
