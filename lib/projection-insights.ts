import type { ProjectionEvent, ProjectionRow } from "./projection";
import { addDaysIso } from "./dates";

export type ProjectionShortfall = {
  date: string;
  balanceCents: number;
  neededCents: number;
  labels: string[];
};

export type ProjectionMonthRunway = {
  startDate: string;
  endDate: string;
  daysRemaining: number;
  incomeRemainingCents: number;
  expenseRemainingCents: number;
  endingBalanceCents: number;
  leftAfterScheduledCents: number;
  perDayCents: number;
};

export type ProjectionHeavyDay = {
  date: string;
  expenseCents: number;
  balanceCents: number;
  labels: string[];
};

export type PaycheckCycle = {
  startDate: string;
  endDate: string;
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  savingsRate: number;
  billCount: number;
  lowBalanceCents: number;
};

export type ExpenseCluster = {
  date: string;
  expenseCents: number;
  billCount: number;
  pctOfIncome: number;
  labels: string[];
};

export type BalanceTrajectory = {
  direction: "improving" | "stable" | "declining";
  startBalanceCents: number;
  endBalanceCents: number;
  deltaCents: number;
  avgBalanceCents: number;
};

export type UncoveredCardDue = {
  cardId: string;
  /** Display label of the due marker (estimated cycles carry an "(est.)" suffix). */
  label: string;
  dueDate: string;
  owedCents: number;
  /** Scheduled-payment cash counted toward this due, clamped to owedCents. */
  coverCents: number;
  shortfallCents: number;
  estimated: boolean;
  /** Portion of coverCents dated after the issuer due date — pays the balance
   *  but doesn't stop interest. A fully-late-covered due has shortfall 0 and
   *  drops out of this list: the user planned it, stop nagging. */
  lateCoverCents: number;
  /** Set for an OVERDUE marker: the original (earliest) issuer due date. */
  overdueSinceDate?: string;
};

export type ProjectionInsights = {
  safeToSpendCents: number;
  safeToSpendThroughDate: string | null;
  nextIncomeDate: string | null;
  nextIncomeCents: number;
  firstShortfall: ProjectionShortfall | null;
  monthRunway: ProjectionMonthRunway | null;
  upcomingHeavyDays: ProjectionHeavyDay[];
  paycheckCycles: PaycheckCycle[];
  savingsRate: number;
  recurringCommitmentRatio: number;
  expenseClusters: ExpenseCluster[];
  balanceTrajectory: BalanceTrajectory | null;
};

function endOfMonthIso(isoDate: string): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${isoDate.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
}

function daysInclusive(startDate: string, endDate: string): number {
  const start = Date.UTC(
    Number(startDate.slice(0, 4)),
    Number(startDate.slice(5, 7)) - 1,
    Number(startDate.slice(8, 10)),
  );
  const end = Date.UTC(
    Number(endDate.slice(0, 4)),
    Number(endDate.slice(5, 7)) - 1,
    Number(endDate.slice(8, 10)),
  );
  return Math.max(0, Math.floor((end - start) / 86_400_000) + 1);
}

function expenseLabels(events: readonly ProjectionEvent[]): string[] {
  return events
    .filter((event) => event.kind !== "paycheck" && event.amountCents > 0)
    .map((event) => event.label);
}

function sumPaychecks(row: ProjectionRow): number {
  return row.events
    .filter((event) => event.kind === "paycheck")
    .reduce((total, event) => total + event.amountCents, 0);
}

function minimumBalance(rows: readonly ProjectionRow[]): number | null {
  if (rows.length === 0) return null;
  return rows.reduce((lowest, row) => Math.min(lowest, row.balanceCents), rows[0]!.balanceCents);
}

export function buildProjectionInsights(
  rows: readonly ProjectionRow[],
  today: string,
  opts: { cashFloorCents?: number; heavyDayLimit?: number } = {},
): ProjectionInsights {
  const cashFloorCents = opts.cashFloorCents ?? 0;
  const heavyDayLimit = opts.heavyDayLimit ?? 3;
  const futureRows = rows.filter((row) => row.date >= today);
  const nextIncomeRow = futureRows.find((row) => row.date > today && sumPaychecks(row) > 0) ?? null;
  const nextIncomeDate = nextIncomeRow?.date ?? null;
  const safeWindow = nextIncomeDate
    ? futureRows.filter((row) => row.date < nextIncomeDate)
    : futureRows;
  const safeWindowLow = minimumBalance(safeWindow);
  const safeToSpendCents =
    safeWindowLow == null ? 0 : Math.max(0, safeWindowLow - cashFloorCents);
  const safeToSpendThroughDate =
    safeWindow.length > 0 ? safeWindow[safeWindow.length - 1]!.date : null;
  const firstShortfallRow =
    futureRows.find((row) => row.balanceCents < cashFloorCents) ?? null;

  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = endOfMonthIso(today);
  const monthRows = rows.filter((row) => row.date >= monthStart && row.date <= monthEnd);
  const remainingMonthRows = monthRows.filter((row) => row.date >= today);
  const monthEndingRow = monthRows[monthRows.length - 1] ?? null;
  const monthRunway =
    monthEndingRow && remainingMonthRows.length > 0
      ? {
          startDate: today,
          endDate: monthEnd,
          daysRemaining: daysInclusive(today, monthEnd),
          incomeRemainingCents: remainingMonthRows.reduce(
            (total, row) => total + row.incomeCents,
            0,
          ),
          expenseRemainingCents: remainingMonthRows.reduce(
            (total, row) => total + row.expenseCents,
            0,
          ),
          endingBalanceCents: monthEndingRow.balanceCents,
          leftAfterScheduledCents: monthEndingRow.balanceCents - cashFloorCents,
          perDayCents: Math.trunc(
            (monthEndingRow.balanceCents - cashFloorCents) / daysInclusive(today, monthEnd),
          ),
        }
      : null;

  const upcomingHeavyDays = futureRows
    .filter((row) => row.expenseCents > 0)
    .map((row) => ({
      date: row.date,
      expenseCents: row.expenseCents,
      balanceCents: row.balanceCents,
      labels: expenseLabels(row.events),
    }))
    .sort((a, b) => b.expenseCents - a.expenseCents || a.date.localeCompare(b.date))
    .slice(0, heavyDayLimit);

  const paycheckCycles = buildPaycheckCycles(futureRows);
  const totalIncome = futureRows.reduce((sum, r) => sum + r.incomeCents, 0);
  const totalExpenses = futureRows.reduce((sum, r) => sum + r.expenseCents, 0);
  const savingsRate = totalIncome > 0 ? Math.max(0, (totalIncome - totalExpenses) / totalIncome) : 0;
  const recurringCommitmentRatio = totalIncome > 0 ? Math.min(totalExpenses / totalIncome, 9.99) : 0;
  const expenseClusters = buildExpenseClusters(futureRows, totalIncome, paycheckCycles);
  const balanceTrajectory = buildBalanceTrajectory(futureRows);

  return {
    safeToSpendCents,
    safeToSpendThroughDate,
    nextIncomeDate,
    nextIncomeCents: nextIncomeRow ? sumPaychecks(nextIncomeRow) : 0,
    firstShortfall: firstShortfallRow
      ? {
          date: firstShortfallRow.date,
          balanceCents: firstShortfallRow.balanceCents,
          neededCents: cashFloorCents - firstShortfallRow.balanceCents,
          labels: expenseLabels(firstShortfallRow.events),
        }
      : null,
    monthRunway,
    upcomingHeavyDays,
    paycheckCycles,
    savingsRate,
    recurringCommitmentRatio,
    expenseClusters,
    balanceTrajectory,
  };
}

function buildPaycheckCycles(rows: readonly ProjectionRow[]): PaycheckCycle[] {
  const cycles: PaycheckCycle[] = [];
  let cycleStart: string | null = null;
  let incomeCents = 0;
  let expenseCents = 0;
  let billCount = 0;
  let lowBalance = Infinity;
  let cycleRows: readonly ProjectionRow[] = [];

  for (const row of rows) {
    const paycheckIncome = sumPaychecks(row);
    if (paycheckIncome > 0 && cycleStart !== null) {
      const endDate = cycleRows.length > 0 ? cycleRows[cycleRows.length - 1]!.date : cycleStart;
      cycles.push({
        startDate: cycleStart,
        endDate,
        incomeCents,
        expenseCents,
        netCents: incomeCents - expenseCents,
        savingsRate: incomeCents > 0 ? Math.max(0, (incomeCents - expenseCents) / incomeCents) : 0,
        billCount,
        lowBalanceCents: lowBalance === Infinity ? 0 : lowBalance,
      });
      cycleStart = null;
      incomeCents = 0;
      expenseCents = 0;
      billCount = 0;
      lowBalance = Infinity;
      cycleRows = [];
    }

    if (paycheckIncome > 0) {
      cycleStart = row.date;
      incomeCents = paycheckIncome;
    }

    if (cycleStart !== null) {
      expenseCents += row.expenseCents;
      billCount += row.events.filter((e) => e.kind !== "paycheck" && e.amountCents > 0).length;
      lowBalance = Math.min(lowBalance, row.balanceCents);
      cycleRows = [...cycleRows, row];
    }
  }

  if (cycleStart !== null && cycleRows.length > 0) {
    const endDate = cycleRows[cycleRows.length - 1]!.date;
    cycles.push({
      startDate: cycleStart,
      endDate,
      incomeCents,
      expenseCents,
      netCents: incomeCents - expenseCents,
      savingsRate: incomeCents > 0 ? Math.max(0, (incomeCents - expenseCents) / incomeCents) : 0,
      billCount,
      lowBalanceCents: lowBalance === Infinity ? 0 : lowBalance,
    });
  }

  return cycles;
}

function buildExpenseClusters(
  rows: readonly ProjectionRow[],
  totalIncome: number,
  cycles: readonly PaycheckCycle[],
): ExpenseCluster[] {
  const avgCycleIncome =
    cycles.length > 0
      ? cycles.reduce((sum, c) => sum + c.incomeCents, 0) / cycles.length
      : totalIncome;
  const threshold = avgCycleIncome > 0 ? avgCycleIncome * 0.3 : Infinity;

  return rows
    .filter((row) => row.expenseCents >= threshold)
    .map((row) => ({
      date: row.date,
      expenseCents: row.expenseCents,
      billCount: row.events.filter((e) => e.kind !== "paycheck" && e.amountCents > 0).length,
      pctOfIncome: avgCycleIncome > 0 ? row.expenseCents / avgCycleIncome : 0,
      labels: expenseLabels(row.events),
    }))
    .sort((a, b) => b.pctOfIncome - a.pctOfIncome)
    .slice(0, 5);
}

function buildBalanceTrajectory(rows: readonly ProjectionRow[]): BalanceTrajectory | null {
  if (rows.length < 2) return null;
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const startBal = first.balanceCents - first.incomeCents + first.expenseCents;
  const endBal = last.balanceCents;
  const deltaCents = endBal - startBal;
  const avgBalanceCents = Math.trunc(
    rows.reduce((sum, r) => sum + r.balanceCents, 0) / rows.length,
  );
  const pctChange = startBal !== 0 ? Math.abs(deltaCents / startBal) : deltaCents !== 0 ? 1 : 0;
  const direction: BalanceTrajectory["direction"] =
    pctChange < 0.05 ? "stable" : deltaCents > 0 ? "improving" : "declining";

  return { direction, startBalanceCents: startBal, endBalanceCents: endBal, deltaCents, avgBalanceCents };
}

/**
 * Card due-date markers inside the horizon whose scheduled-payment coverage
 * falls short of the owed balance — the shortfall accrues interest if nothing
 * else is scheduled before the due date. Coverage semantics live in
 * lib/card-payments.ts (`scheduledCoverCents` on due markers); this only reads
 * the result off projection rows, so partially-covered dues report the
 * remaining shortfall, not the full owed amount.
 */
export function findUncoveredCardDues(
  rows: readonly ProjectionRow[],
  opts: { today: string; horizonDays?: number },
): UncoveredCardDue[] {
  const horizonEnd = addDaysIso(opts.today, opts.horizonDays ?? 14);
  const dues: UncoveredCardDue[] = [];
  for (const row of rows) {
    if (row.date < opts.today || row.date > horizonEnd) continue;
    for (const ev of row.events) {
      if (!ev.dueMarker) continue;
      const owed = ev.paymentDueCents ?? 0;
      if (owed <= 0) continue;
      const cover = Math.min(ev.scheduledCoverCents ?? 0, owed);
      const shortfall = owed - cover;
      if (shortfall <= 0) continue;
      dues.push({
        cardId: ev.sourceId ?? "",
        label: ev.label,
        dueDate: row.date,
        owedCents: owed,
        coverCents: cover,
        shortfallCents: shortfall,
        estimated: ev.estimated === true,
        lateCoverCents: Math.min(ev.lateCoverCents ?? 0, cover),
        overdueSinceDate: ev.overdueSinceDate,
      });
    }
  }
  return dues.sort(
    (a, b) =>
      a.dueDate.localeCompare(b.dueDate) ||
      b.shortfallCents - a.shortfallCents ||
      a.label.localeCompare(b.label),
  );
}
