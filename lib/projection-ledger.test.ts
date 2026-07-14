import { describe, expect, it } from "vitest";
import { buildLedgerSummary } from "./projection-ledger";
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

describe("buildLedgerSummary", () => {
  // A linked account with a past starting-balance date replays history, so the
  // window can start before today. The deepest dip may already have happened.
  const windowRows = [
    row("2026-07-05", 0, 900_00, -300_00), // past low water — already happened
    row("2026-07-10", 1200_00, 0, 900_00),
    row("2026-07-14", 0, 0, 900_00), // today
    row("2026-07-20", 0, 500_00, 400_00), // lowest from today forward
    row("2026-07-25", 0, 100_00, 300_00),
  ];

  it("ignores low balances that already happened, using the lowest upcoming day", () => {
    const summary = buildLedgerSummary(windowRows, windowRows, "2026-07-14");
    // Not the -$300 on Jul 5 (past); the lowest from today forward is $300 on Jul 25.
    expect(summary.lowPoint?.date).toBe("2026-07-25");
    expect(summary.lowPoint?.balanceCents).toBe(300_00);
  });

  it("counts only upcoming negative days, not past ones", () => {
    const summary = buildLedgerSummary(windowRows, windowRows, "2026-07-14");
    // The only negative day (Jul 5) is in the past, so nothing to flag ahead.
    expect(summary.negativeDayCount).toBe(0);
  });

  it("counts a future negative day and points low water at it", () => {
    const rows = [
      row("2026-07-05", 0, 900_00, -300_00), // past dip
      row("2026-07-14", 0, 0, 200_00), // today
      row("2026-07-22", 0, 500_00, -300_00), // upcoming shortfall
    ];
    const summary = buildLedgerSummary(rows, rows, "2026-07-14");
    expect(summary.negativeDayCount).toBe(1);
    expect(summary.lowPoint?.date).toBe("2026-07-22");
  });

  it("keeps opening/closing balances and totals spanning the whole window", () => {
    const summary = buildLedgerSummary(windowRows, windowRows, "2026-07-14");
    // Opening = first row's balance minus its own net (900 debit → prior +600).
    expect(summary.openingBalanceCents).toBe(600_00);
    expect(summary.closingBalanceCents).toBe(300_00);
    expect(summary.totalIncomeCents).toBe(1200_00);
    expect(summary.totalExpenseCents).toBe(1500_00);
  });

  it("returns no low point when the window is entirely in the past", () => {
    const rows = [
      row("2026-07-01", 0, 100_00, 50_00),
      row("2026-07-05", 0, 200_00, -150_00),
    ];
    const summary = buildLedgerSummary(rows, rows, "2026-07-14");
    expect(summary.lowPoint).toBeNull();
    expect(summary.negativeDayCount).toBe(0);
  });
});
