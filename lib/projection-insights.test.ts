import { describe, expect, it } from "vitest";
import { buildProjectionInsights } from "./projection-insights";
import type { ProjectionRow } from "./projection";

const row = (
  date: string,
  incomeCents: number,
  expenseCents: number,
  balanceCents: number,
  events: ProjectionRow["events"] = [],
): ProjectionRow => ({
  date,
  incomeCents,
  expenseCents,
  balanceCents,
  events,
});

describe("buildProjectionInsights", () => {
  it("computes spendable buffer before the next income event", () => {
    const insights = buildProjectionInsights(
      [
        row("2026-05-16", 0, 100_00, 900_00, [
          { kind: "bill", label: "Phone", amountCents: 100_00 },
        ]),
        row("2026-05-17", 0, 850_00, 50_00, [
          { kind: "bill", label: "Rent", amountCents: 850_00 },
        ]),
        row("2026-05-18", 1200_00, 0, 1250_00, [
          { kind: "paycheck", label: "Paycheck", amountCents: 1200_00 },
        ]),
      ],
      "2026-05-16",
    );

    expect(insights.safeToSpendCents).toBe(50_00);
    expect(insights.safeToSpendThroughDate).toBe("2026-05-17");
    expect(insights.nextIncomeDate).toBe("2026-05-18");
    expect(insights.nextIncomeCents).toBe(1200_00);
  });

  it("surfaces the first future shortfall and the cash needed to clear it", () => {
    const insights = buildProjectionInsights(
      [
        row("2026-05-16", 0, 0, 300_00),
        row("2026-05-17", 0, 500_00, -200_00, [
          { kind: "bill", label: "Insurance", amountCents: 500_00 },
        ]),
        row("2026-05-18", 0, 25_00, -225_00, [
          { kind: "bill", label: "Streaming", amountCents: 25_00 },
        ]),
      ],
      "2026-05-16",
    );

    expect(insights.firstShortfall).toEqual({
      date: "2026-05-17",
      balanceCents: -200_00,
      neededCents: 200_00,
      labels: ["Insurance"],
    });
  });

  it("builds current-month runway from the remaining projected month", () => {
    const insights = buildProjectionInsights(
      [
        row("2026-05-15", 0, 100_00, 1000_00),
        row("2026-05-16", 500_00, 0, 1500_00, [
          { kind: "paycheck", label: "Paycheck", amountCents: 500_00 },
        ]),
        row("2026-05-20", 0, 300_00, 1200_00, [
          { kind: "bill", label: "Car", amountCents: 300_00 },
        ]),
        row("2026-05-31", 0, 200_00, 1000_00, [
          { kind: "bill", label: "Groceries", amountCents: 200_00 },
        ]),
      ],
      "2026-05-16",
    );

    expect(insights.monthRunway).toMatchObject({
      startDate: "2026-05-16",
      endDate: "2026-05-31",
      daysRemaining: 16,
      incomeRemainingCents: 500_00,
      expenseRemainingCents: 500_00,
      endingBalanceCents: 1000_00,
      leftAfterScheduledCents: 1000_00,
      perDayCents: 62_50,
    });
  });

  it("orders upcoming heavy expense days by projected outflow", () => {
    const insights = buildProjectionInsights(
      [
        row("2026-05-16", 0, 40_00, 960_00, [
          { kind: "bill", label: "Internet", amountCents: 40_00 },
        ]),
        row("2026-05-17", 0, 500_00, 460_00, [
          { kind: "bill", label: "Rent", amountCents: 500_00 },
        ]),
        row("2026-05-18", 0, 80_00, 380_00, [
          { kind: "extra", label: "Concert", amountCents: 80_00 },
        ]),
      ],
      "2026-05-16",
      { heavyDayLimit: 2 },
    );

    expect(insights.upcomingHeavyDays.map((day) => day.date)).toEqual([
      "2026-05-17",
      "2026-05-18",
    ]);
    expect(insights.upcomingHeavyDays[0]?.labels).toEqual(["Rent"]);
  });

  it("builds paycheck cycles with income/expense/savings per cycle", () => {
    const insights = buildProjectionInsights(
      [
        row("2026-05-01", 3000_00, 0, 3000_00, [
          { kind: "paycheck", label: "Salary", amountCents: 3000_00 },
        ]),
        row("2026-05-05", 0, 1200_00, 1800_00, [
          { kind: "bill", label: "Rent", amountCents: 1200_00 },
        ]),
        row("2026-05-10", 0, 100_00, 1700_00, [
          { kind: "bill", label: "Phone", amountCents: 100_00 },
        ]),
        row("2026-05-15", 3000_00, 0, 4700_00, [
          { kind: "paycheck", label: "Salary", amountCents: 3000_00 },
        ]),
        row("2026-05-20", 0, 800_00, 3900_00, [
          { kind: "bill", label: "Car", amountCents: 800_00 },
        ]),
      ],
      "2026-05-01",
    );

    expect(insights.paycheckCycles).toHaveLength(2);
    expect(insights.paycheckCycles[0]).toMatchObject({
      startDate: "2026-05-01",
      endDate: "2026-05-10",
      incomeCents: 3000_00,
      expenseCents: 1300_00,
      netCents: 1700_00,
      billCount: 2,
    });
    expect(insights.paycheckCycles[0]!.savingsRate).toBeCloseTo(1700 / 3000, 2);
    expect(insights.paycheckCycles[1]).toMatchObject({
      startDate: "2026-05-15",
      incomeCents: 3000_00,
      expenseCents: 800_00,
    });
  });

  it("computes savings rate as fraction of income surviving expenses", () => {
    const insights = buildProjectionInsights(
      [
        row("2026-05-01", 2000_00, 0, 2000_00, [
          { kind: "paycheck", label: "Pay", amountCents: 2000_00 },
        ]),
        row("2026-05-10", 0, 1500_00, 500_00, [
          { kind: "bill", label: "Rent", amountCents: 1500_00 },
        ]),
      ],
      "2026-05-01",
    );

    expect(insights.savingsRate).toBeCloseTo(0.25, 2);
    expect(insights.recurringCommitmentRatio).toBeCloseTo(0.75, 2);
  });

  it("detects expense clusters where a single day eats ≥30% of avg cycle income", () => {
    const insights = buildProjectionInsights(
      [
        row("2026-05-01", 1000_00, 0, 1000_00, [
          { kind: "paycheck", label: "Pay", amountCents: 1000_00 },
        ]),
        row("2026-05-02", 0, 50_00, 950_00, [
          { kind: "bill", label: "Netflix", amountCents: 50_00 },
        ]),
        row("2026-05-03", 0, 400_00, 550_00, [
          { kind: "bill", label: "Rent", amountCents: 350_00 },
          { kind: "bill", label: "Insurance", amountCents: 50_00 },
        ]),
      ],
      "2026-05-01",
    );

    expect(insights.expenseClusters.length).toBeGreaterThanOrEqual(1);
    expect(insights.expenseClusters[0]!.date).toBe("2026-05-03");
    expect(insights.expenseClusters[0]!.pctOfIncome).toBeCloseTo(0.4, 1);
  });

  it("computes balance trajectory direction over the projection window", () => {
    const improving = buildProjectionInsights(
      [
        row("2026-05-01", 3000_00, 0, 3000_00, [
          { kind: "paycheck", label: "Pay", amountCents: 3000_00 },
        ]),
        row("2026-05-15", 0, 1000_00, 2000_00, [
          { kind: "bill", label: "Bills", amountCents: 1000_00 },
        ]),
        row("2026-06-01", 3000_00, 0, 5000_00, [
          { kind: "paycheck", label: "Pay", amountCents: 3000_00 },
        ]),
        row("2026-06-15", 0, 1000_00, 4000_00, [
          { kind: "bill", label: "Bills", amountCents: 1000_00 },
        ]),
      ],
      "2026-05-01",
    );

    expect(improving.balanceTrajectory).not.toBeNull();
    expect(improving.balanceTrajectory!.direction).toBe("improving");
    expect(improving.balanceTrajectory!.deltaCents).toBe(4000_00);
  });

  it("marks trajectory as declining when expenses exceed income", () => {
    const declining = buildProjectionInsights(
      [
        row("2026-05-01", 1000_00, 0, 5000_00, [
          { kind: "paycheck", label: "Pay", amountCents: 1000_00 },
        ]),
        row("2026-05-10", 0, 2000_00, 3000_00, [
          { kind: "bill", label: "Big bills", amountCents: 2000_00 },
        ]),
        row("2026-05-20", 0, 1500_00, 1500_00, [
          { kind: "bill", label: "More bills", amountCents: 1500_00 },
        ]),
      ],
      "2026-05-01",
    );

    expect(declining.balanceTrajectory!.direction).toBe("declining");
  });

  it("marks trajectory as stable when net change is under 5%", () => {
    const stable = buildProjectionInsights(
      [
        row("2026-05-01", 2000_00, 0, 10000_00, [
          { kind: "paycheck", label: "Pay", amountCents: 2000_00 },
        ]),
        row("2026-05-15", 0, 1980_00, 8020_00, [
          { kind: "bill", label: "Bills", amountCents: 1980_00 },
        ]),
      ],
      "2026-05-01",
    );

    // startBal = 10000 - 2000 + 0 = 8000, endBal = 8020, delta = 20, pct = 0.25%
    expect(stable.balanceTrajectory!.direction).toBe("stable");
  });
});
