import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { buildProjection } from "@/lib/projection-server";
import { listBills, listExtras, listPaychecks, listStatementsForUser, computeCategoryUtilization, getPrimaryLinkedBalance } from "@/lib/repos";
import { isStatementOpen, statementCashDueCents } from "@/lib/credit-cards";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CardSubTag, PageHead } from "@/components/ui/page-head";
import { Tile, TileGrid } from "@/components/ui/tile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertBar } from "@/components/ui/alert-bar";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import { ProjectionChart } from "@/components/projection-chart";
import { addDaysIso, todayIso } from "@/lib/dates";
import { findWorstDay } from "@/lib/projection";
import { cn } from "@/lib/cn";
import { Plus, Download } from "lucide-react";
import { BudgetUtilization } from "@/components/budget-utilization";

export const dynamic = "force-dynamic";

function netClass(cents: number) {
  if (cents > 0) return "text-[var(--mint)]";
  if (cents < 0) return "text-[var(--red)]";
  return "";
}

function balanceClass(cents: number) {
  if (cents < 0) return "text-[var(--red)]";
  if (cents < 50000) return "text-[var(--amber)]";
  return "text-[var(--mint)]";
}

export default async function DashboardPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const projection = await buildProjection(userId);
  if (!projection) redirect("/setup");
  const { rows, projectionMonths, promoDriftByCard } = projection;
  const totalPromoDriftCents = Object.values(promoDriftByCard).reduce((s, n) => s + n, 0);
  const driftedCardCount = Object.keys(promoDriftByCard).length;

  const currentMonth = todayIso().slice(0, 7);
  const [bills, extras, paychecks, ccStatements, budgetUtilization, liveBalance] = await Promise.all([
    listBills(userId, false),
    listExtras(userId),
    listPaychecks(userId),
    listStatementsForUser(userId),
    computeCategoryUtilization(userId, currentMonth),
    getPrimaryLinkedBalance(userId),
  ]);

  // Credit card "due to avoid interest" totals
  const openStatements = ccStatements.filter(isStatementOpen);
  const ccTotalDue = openStatements.reduce((s, x) => s + statementCashDueCents(x), 0);
  const ccNextDue =
    openStatements.length > 0
      ? [...openStatements].sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]
      : null;
  const ccOverdueCount = openStatements.filter((s) => s.dueDate < todayIso()).length;

  const totalMonthlyBills = bills.reduce(
    (sum, b) => sum + (b.intervalMonths > 0 ? Math.round(b.amountCents / b.intervalMonths) : b.amountCents),
    0,
  );
  // Annualized cost of bills that don't recur monthly (quarterly, annual, etc.).
  const nonMonthlyBills = bills.filter((b) => b.intervalMonths > 1);
  const totalAnnualBills = nonMonthlyBills.reduce(
    (sum, b) => sum + Math.round((b.amountCents * 12) / b.intervalMonths),
    0,
  );

  const today = todayIso();
  const next90 = addDaysIso(today, 90);
  const upcomingExtras = extras
    .filter((e) => e.date >= today && e.date <= next90)
    .reduce((sum, e) => sum + e.amountCents, 0);
  const upcomingExtraCount = extras.filter((e) => e.date >= today && e.date <= next90).length;

  const upcomingPaychecks = paychecks.filter((p) => p.payDate >= today);
  const nextPayday = upcomingPaychecks[0];

  const totalIncome = rows.reduce((s, r) => s + r.incomeCents, 0);
  const avgMonthlyIncome = projectionMonths > 0 ? Math.round(totalIncome / projectionMonths) : 0;

  type MonthAgg = { key: string; income: number; expense: number; ending: number };
  const months: MonthAgg[] = [];
  for (const row of rows) {
    const key = row.date.slice(0, 7);
    let m = months[months.length - 1];
    if (!m || m.key !== key) {
      m = { key, income: 0, expense: 0, ending: 0 };
      months.push(m);
    }
    m.income += row.incomeCents;
    m.expense += row.expenseCents;
    m.ending = row.balanceCents;
  }

  const worst = findWorstDay(rows);
  const worstIsRisk = worst && worst.balanceCents < 50000;

  // Balance vs projection delta: compare live Plaid balance to today's projected balance
  const todayRow = rows.find((r) => r.date === today);
  const projectedTodayCents = todayRow?.balanceCents ?? projection.startingBalanceCents;
  const balanceDeltaCents = liveBalance != null ? liveBalance - projectedTodayCents : null;
  const balanceDeltaSignificant =
    balanceDeltaCents != null && Math.abs(balanceDeltaCents) > 50_00; // > $50 drift

  // Build "upcoming events" list — next 6 income/expense rows
  const upcomingEvents = rows
    .filter((r) => r.date >= today && (r.events.length > 0))
    .slice(0, 5);

  return (
    <div className="fade-in space-y-4">
      <PageHead
        module="MODULE_01"
        title="OVERVIEW"
        subtitle="Cash-flow projection and runway analysis"
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/api/backup/export">
                <Download className="h-3 w-3" /> EXPORT
              </Link>
            </Button>
            <Button variant="primary" asChild>
              <Link href="/bills">
                <Plus className="h-3 w-3" /> NEW BILL
              </Link>
            </Button>
          </>
        }
      />

      <TileGrid cols={4}>
        <Tile
          compact
          label="MONTHLY BILLS"
          value={<Money cents={totalMonthlyBills} />}
          delta={`amortized across all cycles`}
        />
        <Tile
          compact
          label="NON-MONTHLY (ANNUALIZED)"
          value={<Money cents={totalAnnualBills} />}
          delta={`${nonMonthlyBills.length} tracked`}
        />
        <Tile
          compact
          label="ONE-TIME (90D)"
          value={<Money cents={upcomingExtras} />}
          delta={`${upcomingExtraCount} planned`}
        />
        <Tile
          compact
          label="AVG MONTHLY INCOME"
          value={<Money cents={avgMonthlyIncome} />}
          variant="mint"
          delta={`net: ${avgMonthlyIncome - totalMonthlyBills > 0 ? "+" : ""}${formatDelta(avgMonthlyIncome - totalMonthlyBills)}`}
        />
        <Tile
          compact
          label="NEXT PAYDAY"
          value={
            nextPayday ? (
              <DateLabel iso={nextPayday.payDate} format="short" />
            ) : (
              <span className="text-[var(--text-2)] text-base">—</span>
            )
          }
          delta={
            nextPayday ? (
              <>in {daysBetween(today, nextPayday.payDate)} days · <Money cents={nextPayday.amountCents} /></>
            ) : (
              "none scheduled"
            )
          }
        />
        <Tile
          compact
          label="CREDIT DUE"
          badge={
            ccOverdueCount > 0 ? (
              <Badge variant="destructive">OVERDUE</Badge>
            ) : ccTotalDue > 0 ? (
              <Badge variant="warning">UNPAID</Badge>
            ) : null
          }
          value={
            ccTotalDue > 0 ? (
              <Money cents={ccTotalDue} />
            ) : (
              <span className="text-[var(--text-2)] text-base">—</span>
            )
          }
          variant={ccOverdueCount > 0 ? "red" : ccTotalDue > 0 ? "amber" : "default"}
          delta={
            ccNextDue ? (
              <>
                next: <Link href="/credit-cards" className="text-[var(--mint)] hover:underline">
                  {ccNextDue.cardName}
                </Link>{" "}
                · <DateLabel iso={ccNextDue.dueDate} format="short" />
              </>
            ) : (
              "no open statements"
            )
          }
        />
        <Tile
          compact
          label="PROJECTED LOW"
          badge={worstIsRisk ? <Badge variant="destructive">RISK</Badge> : null}
          value={
            worst ? <Money cents={worst.balanceCents} /> : <span className="text-[var(--text-2)]">—</span>
          }
          variant={worstIsRisk ? "red" : "default"}
          delta={
            worst ? (
              <>
                <DateLabel iso={worst.date} format="short" /> · {daysBetween(today, worst.date)} days out
              </>
            ) : null
          }
        />
      </TileGrid>

      {totalPromoDriftCents > 0 ? (
        <AlertBar tag="DRIFT" variant="amber">
          Promo records exceed live card balances on{" "}
          <strong className="text-[var(--amber)]">
            {driftedCardCount} card{driftedCardCount === 1 ? "" : "s"}
          </strong>{" "}
          by <Money cents={totalPromoDriftCents} />. The projection silently caps the
          difference so the open-cycle estimate stays positive — but this means a promo
          decrement was missed somewhere.{" "}
          <Link href="/credit-cards" className="text-[var(--mint)] hover:underline">
            Reconcile →
          </Link>
        </AlertBar>
      ) : null}

      {balanceDeltaSignificant && balanceDeltaCents != null ? (
        <AlertBar
          tag="DELTA"
          variant={balanceDeltaCents < 0 ? "red" : "mint"}
        >
          Live balance is{" "}
          <strong className={balanceDeltaCents < 0 ? "text-[var(--red)]" : "text-[var(--mint)]"}>
            {balanceDeltaCents > 0 ? "+" : "−"}
            <Money cents={Math.abs(balanceDeltaCents)} />
          </strong>{" "}
          vs today{"'"}s projected balance of <Money cents={projectedTodayCents} />.{" "}
          {balanceDeltaCents < 0
            ? "Actual spending may be higher than projected."
            : "Unexpected income or lower spending than projected."}
        </AlertBar>
      ) : null}

      {worst && worstIsRisk ? (
        <AlertBar tag="RISK" variant="red">
          Projected low of <Money cents={worst.balanceCents} /> on{" "}
          <DateLabel iso={worst.date} format="long" />.{" "}
          <Link href={`/projection#d-${worst.date}`} className="text-[var(--mint)] hover:underline">
            Jump to day →
          </Link>
        </AlertBar>
      ) : null}

      <Card>
        <CardHeader className="px-4 py-3">
          <div>
            <CardSubTag>CHART_01</CardSubTag>
            <CardTitle className="mt-0.5 text-[14px]">DAILY BALANCE PROJECTION</CardTitle>
          </div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]">
            NEXT {projectionMonths} MONTHS
          </div>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <ProjectionChart data={rows.map((r) => ({ date: r.date, balanceCents: r.balanceCents }))} />
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader className="px-4 py-3">
            <div>
              <CardSubTag>TABLE_01</CardSubTag>
              <CardTitle className="mt-0.5 text-[14px]">MONTHLY SUMMARY</CardTitle>
            </div>
            <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]">
              PROJECTION_MONTHS = {projectionMonths}
            </div>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] font-mono tabular">
              <thead>
                <tr className="border-b border-[var(--border-raw)] bg-[var(--bg-1)] text-left">
                  <th className="px-3 py-2 text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-3)]">
                    MONTH
                  </th>
                  <th className="px-3 py-2 text-right text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-3)]">
                    INCOME
                  </th>
                  <th className="px-3 py-2 text-right text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-3)]">
                    BILLS
                  </th>
                  <th className="px-3 py-2 text-right text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-3)]">
                    NET
                  </th>
                  <th className="px-3 py-2 text-right text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-3)]">
                    END BAL
                  </th>
                </tr>
              </thead>
              <tbody>
                {months.slice(0, projectionMonths).map((m) => {
                  const net = m.income - m.expense;
                  return (
                    <tr key={m.key} className="border-b border-[var(--border-raw)] last:border-0 hover:bg-[var(--bg-2)]">
                      <td className="px-3 py-2 font-semibold text-[var(--text-0)] uppercase">{m.key}</td>
                      <td className="px-3 py-2 text-right">
                        <Money cents={m.income} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Money cents={m.expense} />
                      </td>
                      <td className={cn("px-3 py-2 text-right font-bold", netClass(net))}>
                        <Money cents={net} signed />
                      </td>
                      <td className={cn("px-3 py-2 text-right font-bold", balanceClass(m.ending))}>
                        <Money cents={m.ending} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHeader className="px-4 py-3">
            <div>
              <CardSubTag>LOG_01</CardSubTag>
              <CardTitle className="mt-0.5 text-[14px]">UPCOMING EVENTS</CardTitle>
            </div>
            <Link
              href="/projection"
              className="text-[10px] uppercase tracking-[0.15em] text-[var(--mint)] hover:text-[var(--mint-bright)]"
            >
              VIEW ALL →
            </Link>
          </CardHeader>
          <div className="px-2 py-1">
            {upcomingEvents.length === 0 ? (
              <div className="px-4 py-6 text-center text-[10px] uppercase tracking-[0.15em] text-[var(--text-3)]">
                No upcoming events
              </div>
            ) : (
              upcomingEvents.map((row) => (
                <div
                  key={row.date}
                  className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-2 border-b border-[var(--border-raw)] px-3 py-2 last:border-0 hover:bg-[var(--bg-2)]"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[11px] font-medium text-[var(--text-0)]">
                      {row.events.map((e) => e.label).slice(0, 2).join(" + ")}
                      {row.events.length > 2 ? ` +${row.events.length - 2}` : ""}
                    </div>
                    <div className="mt-1 text-[9px] uppercase tracking-[0.12em] text-[var(--text-3)]">
                      <DateLabel iso={row.date} format="short" /> ·{" "}
                      {row.incomeCents > 0 ? "INCOME" : "EXPENSE"}
                    </div>
                  </div>
                  <div
                    className={cn(
                      "tabular text-[12px] font-bold",
                      row.incomeCents > 0 ? "text-[var(--mint)]" : "text-[var(--red)]",
                    )}
                  >
                    {row.incomeCents > 0 ? "+" : "−"}
                    <Money cents={Math.abs(row.incomeCents - row.expenseCents)} />
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {budgetUtilization.length > 0 && (
        <Card>
          <CardHeader className="px-4 py-3">
            <div>
              <CardSubTag>BUDGET_01</CardSubTag>
              <CardTitle className="mt-0.5 text-[14px]">CATEGORY BUDGETS</CardTitle>
            </div>
            <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]">
              {currentMonth}
            </div>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <BudgetUtilization rows={budgetUtilization} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.max(0, Math.round((db - da) / (1000 * 60 * 60 * 24)));
}

function formatDelta(cents: number): string {
  const dollars = Math.abs(cents) / 100;
  return `$${dollars.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
