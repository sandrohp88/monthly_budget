import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { buildProjection } from "@/lib/projection-server";
import { listPaychecks, listPromos, listStatementsForUser, computeCategoryUtilization, getPrimaryLinkedBalance } from "@/lib/repos";
import { interestSavingCashDueCents, isStatementOpen } from "@/lib/credit-cards";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHead } from "@/components/ui/page-head";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { Plus } from "lucide-react";
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

function balanceVariant(cents: number): "mint" | "amber" | "red" {
  if (cents < 0) return "red";
  if (cents < 50000) return "amber";
  return "mint";
}

const AGENDA_DAYS = 14;
const AGENDA_MAX_CARDS = 12;

export default async function DashboardPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const projection = await buildProjection(userId);
  if (!projection) redirect("/setup");
  const { rows, projectionMonths, promoDriftByCard, unpaidRecentOccurrences } = projection;
  const totalPromoDriftCents = Object.values(promoDriftByCard).reduce((s, n) => s + n, 0);
  const driftedCardCount = Object.keys(promoDriftByCard).length;

  const currentMonth = todayIso().slice(0, 7);
  const [paychecks, ccStatements, ccPromos, budgetUtilization, liveBalance] = await Promise.all([
    listPaychecks(userId),
    listStatementsForUser(userId),
    listPromos(userId),
    computeCategoryUtilization(userId, currentMonth),
    getPrimaryLinkedBalance(userId),
  ]);

  // Credit card "due to avoid interest" totals — the Interest Saving Balance
  // for cards with active 0% promos, the full statement cash due otherwise.
  const promosByCard = new Map<string, typeof ccPromos>();
  for (const p of ccPromos) {
    const list = promosByCard.get(p.cardId) ?? [];
    list.push(p);
    promosByCard.set(p.cardId, list);
  }
  const openStatements = ccStatements.filter(isStatementOpen);
  const ccTotalDue = openStatements.reduce(
    (s, x) => s + interestSavingCashDueCents(x, promosByCard.get(x.cardId) ?? []),
    0,
  );
  const ccNextDue =
    openStatements.length > 0
      ? [...openStatements].sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]
      : null;
  const ccOverdueCount = openStatements.filter((s) => s.dueDate < todayIso()).length;

  const today = todayIso();
  const upcomingPaychecks = paychecks.filter((p) => p.payDate >= today);
  const nextPayday = upcomingPaychecks[0];

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

  // "Projected low" is a forward-looking warning — a dip that already happened
  // (linked accounts replay a lookback window of past rows) isn't actionable,
  // so only consider today onward.
  const worst = findWorstDay(rows.filter((r) => r.date >= today));
  const worstIsRisk = worst && worst.balanceCents < 50000;

  // Balance vs projection delta: compare live Plaid balance to today's projected balance
  const todayRow = rows.find((r) => r.date === today);
  const projectedTodayCents = todayRow?.balanceCents ?? projection.startingBalanceCents;
  const currentBalanceCents = liveBalance ?? projectedTodayCents;
  const balanceDeltaCents = liveBalance != null ? liveBalance - projectedTodayCents : null;
  const balanceDeltaSignificant =
    balanceDeltaCents != null && Math.abs(balanceDeltaCents) > 50_00; // > $50 drift

  // Horizontal agenda: the next two weeks, one card per day that has
  // something scheduled. Settled/paid zero-amount markers and card-charged
  // bills are calendar detail — skip them here so the strip only shows cash
  // still in motion.
  const agendaEnd = addDaysIso(today, AGENDA_DAYS);
  const agendaDays = rows
    .filter((r) => r.date >= today && r.date <= agendaEnd)
    .map((r) => ({
      ...r,
      events: r.events.filter(
        (e) => !(e.isPaid && e.amountCents === 0) && !e.chargedToCardName,
      ),
    }))
    .filter((r) => r.events.length > 0)
    .slice(0, AGENDA_MAX_CARDS);

  return (
    <div className="fade-in space-y-4">
      <PageHead
        title="Overview"
        subtitle="Cash-flow projection and runway analysis"
        actions={
          <Button variant="primary" asChild>
            <Link href="/bills">
              <Plus className="h-3 w-3" /> New bill
            </Link>
          </Button>
        }
      />

      <TileGrid cols={4}>
        <Tile
          compact
          label="Current balance"
          value={<Money cents={currentBalanceCents} />}
          variant={balanceVariant(currentBalanceCents)}
          delta={liveBalance != null ? "live · linked accounts" : "projected as of today"}
        />
        <Tile
          compact
          label="Next payday"
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
          label="Credit due"
          badge={
            ccOverdueCount > 0 ? (
              <Badge variant="destructive">Overdue</Badge>
            ) : ccTotalDue > 0 ? (
              <Badge variant="warning">Unpaid</Badge>
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
          label="Projected low"
          badge={worstIsRisk ? <Badge variant="destructive">Risk</Badge> : null}
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

      {unpaidRecentOccurrences.length > 0 ? (
        <AlertBar tag="Unpaid" variant="amber">
          No matching payment has posted for{" "}
          {unpaidRecentOccurrences.slice(0, 3).map((o, i) => (
            <span key={`${o.billId}-${o.dueDate}`}>
              {i > 0 ? ", " : ""}
              <strong className="text-[var(--amber)]">{o.billName}</strong> (due{" "}
              <DateLabel iso={o.dueDate} format="short" /> · <Money cents={o.expectedCents} />)
            </span>
          ))}
          {unpaidRecentOccurrences.length > 3
            ? ` and ${unpaidRecentOccurrences.length - 3} more`
            : ""}
          . If a payment posted under different wording, link it to the bill.{" "}
          <Link href="/transactions" className="text-[var(--mint)] hover:underline">
            Review transactions →
          </Link>
        </AlertBar>
      ) : null}

      {totalPromoDriftCents > 0 ? (
        <AlertBar tag="Drift" variant="amber">
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
          tag="Delta"
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
        <AlertBar tag="Risk" variant="red">
          Projected low of <Money cents={worst.balanceCents} /> on{" "}
          <DateLabel iso={worst.date} format="long" />.{" "}
          <Link href={`/ledger#d-${worst.date}`} className="text-[var(--mint)] hover:underline">
            Jump to day →
          </Link>
        </AlertBar>
      ) : null}

      <Card>
        <CardHeader className="px-4 py-3">
          <CardTitle className="text-[14px]">Daily balance projection</CardTitle>
          <div className="text-2xs text-[var(--text-2)]">Next {projectionMonths} months</div>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <ProjectionChart data={rows.map((r) => ({ date: r.date, balanceCents: r.balanceCents }))} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-4 py-3">
          <CardTitle className="text-[14px]">Next {AGENDA_DAYS} days</CardTitle>
          <Link
            href="/calendar"
            className="text-2xs font-medium text-[var(--mint)] hover:text-[var(--mint-bright)]"
          >
            Open calendar →
          </Link>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          {agendaDays.length === 0 ? (
            <div className="py-5 text-center text-2xs text-[var(--text-3)]">
              Nothing scheduled in the next {AGENDA_DAYS} days
            </div>
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {agendaDays.map((row) => {
                const net = row.incomeCents - row.expenseCents;
                return (
                  <Link
                    key={row.date}
                    href="/calendar"
                    className={cn(
                      "w-[190px] shrink-0 rounded-md border bg-[var(--bg-1)] p-2.5 transition-colors hover:border-[var(--border-2)]",
                      row.date === today ? "border-[var(--mint-dim)]" : "border-[var(--border-raw)]",
                    )}
                  >
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-2xs font-semibold text-[var(--text-2)]">
                        <DateLabel iso={row.date} format="short" />
                      </span>
                      <span className={cn("tabular text-[11px] font-bold", netClass(net))}>
                        {net > 0 ? "+" : net < 0 ? "−" : ""}
                        <Money cents={Math.abs(net)} />
                      </span>
                    </div>
                    <div className="space-y-0.5">
                      {row.events.slice(0, 3).map((ev, i) => {
                        const credit = ev.kind === "paycheck" || (ev.kind === "extra" && ev.amountCents < 0);
                        return (
                          <div key={i} className="flex items-center justify-between gap-1.5 text-2xs leading-tight">
                            <span className="min-w-0 truncate text-[var(--text-1)]">{ev.label}</span>
                            <span className={cn("tabular shrink-0", credit ? "text-[var(--mint)]" : "text-[var(--red)]")}>
                              {credit ? "+" : "−"}
                              <Money cents={Math.abs(ev.amountCents)} />
                            </span>
                          </div>
                        );
                      })}
                      {row.events.length > 3 ? (
                        <div className="text-2xs text-[var(--text-3)]">
                          +{row.events.length - 3} more
                        </div>
                      ) : null}
                    </div>
                    <div className="mt-2 flex items-center justify-between border-t border-[var(--border-raw)] pt-1.5 text-2xs text-[var(--text-3)]">
                      <span>End of day</span>
                      <span className={cn("tabular text-2xs font-semibold", balanceClass(row.balanceCents))}>
                        <Money cents={row.balanceCents} />
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-4 py-3">
          <CardTitle className="text-[14px]">Monthly summary</CardTitle>
          <div className="text-2xs text-[var(--text-2)]">{projectionMonths} months</div>
        </CardHeader>
        <Table stackOnMobile>
          <TableHeader>
            <TableRow>
              <TableHead>Month</TableHead>
              <TableHead className="text-right">Income</TableHead>
              <TableHead className="text-right">Bills</TableHead>
              <TableHead className="text-right">Net</TableHead>
              <TableHead className="text-right">End bal</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {months.slice(0, projectionMonths).map((m) => {
              const net = m.income - m.expense;
              return (
                <TableRow key={m.key}>
                  <TableCell label="Month" className="font-semibold text-[var(--text-0)]">
                    {m.key}
                  </TableCell>
                  <TableCell label="Income" className="text-right">
                    <Money cents={m.income} />
                  </TableCell>
                  <TableCell label="Bills" className="text-right">
                    <Money cents={m.expense} />
                  </TableCell>
                  <TableCell label="Net" className={cn("text-right font-bold", netClass(net))}>
                    <Money cents={net} signed />
                  </TableCell>
                  <TableCell label="End bal" className={cn("text-right font-bold", balanceClass(m.ending))}>
                    <Money cents={m.ending} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      {budgetUtilization.length > 0 && (
        <Card>
          <CardHeader className="px-4 py-3">
            <CardTitle className="text-[14px]">Category budgets</CardTitle>
            <div className="text-2xs text-[var(--text-2)]">{currentMonth}</div>
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
