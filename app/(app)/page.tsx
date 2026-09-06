import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { buildProjection } from "@/lib/projection-server";
import { listPaychecks, listPromos, listStatementsForUser, computeCategoryUtilization, getPrimaryLinkedBalance, getSettings } from "@/lib/repos";
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
import { addDaysIso, DEFAULT_TIMEZONE, todayIso } from "@/lib/dates";
import { findWorstDay } from "@/lib/projection";
import { findUncoveredCardDues } from "@/lib/projection-insights";
import { showsPostedBalance } from "@/lib/soft-balance";
import { cn } from "@/lib/cn";
import { Plus } from "lucide-react";
import { BudgetUtilization } from "@/components/budget-utilization";
import { PendingPostingAlert } from "@/components/pending-posting-alert";

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
/** Card due dates this close get the uncovered-balance interest alert. */
const CARD_DUE_ALERT_DAYS = 14;
/** An uncovered due this close escalates the alert from amber to red. */
const CARD_DUE_URGENT_DAYS = 7;

export default async function DashboardPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const [projection, settings] = await Promise.all([
    buildProjection(userId),
    getSettings(userId),
  ]);
  if (!projection) redirect("/setup");
  const { rows, projectionMonths, promoDriftByCard, unpaidRecentOccurrences, pendingPosting } =
    projection;
  const totalPromoDriftCents = Object.values(promoDriftByCard).reduce((s, n) => s + n, 0);
  const driftedCardCount = Object.keys(promoDriftByCard).length;

  const today = todayIso(settings?.timezone ?? DEFAULT_TIMEZONE);
  const currentMonth = today.slice(0, 7);
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
  const ccOverdueCount = openStatements.filter((s) => s.dueDate < today).length;

  const upcomingPaychecks = paychecks.filter((p) => p.payDate >= today);
  const nextPayday = upcomingPaychecks[0];

  // Card due dates coming up whose balance no scheduled payment (fully) covers
  // — the shortfall starts accruing interest the day after the due date.
  const uncoveredCardDues = findUncoveredCardDues(rows, {
    today,
    horizonDays: CARD_DUE_ALERT_DAYS,
  });
  const uncoveredDueUrgent =
    uncoveredCardDues.length > 0 &&
    uncoveredCardDues[0]!.dueDate <= addDaysIso(today, CARD_DUE_URGENT_DAYS);

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
  // Two answers to two different questions. POSTED is what the bank would show
  // right now; SOFT subtracts money already on its way out. The soft figure is
  // primary — it's the one you can actually plan against — with posted shown
  // beside it so the app's number can be reconciled against a banking app's.
  const postedNowCents = liveBalance ?? todayRow?.postedBalanceCents ?? projectedTodayCents;
  const inFlightCents = pendingPosting.totalHeldCents;
  const currentBalanceCents = postedNowCents - inFlightCents;
  // Cash held for unposted payments is a DELIBERATE gap between the live
  // balance and the projection, not drift: the money is still inside
  // `balances.current` precisely because it hasn't posted. Adding it back
  // before comparing leaves only the genuinely unexplained remainder —
  // otherwise this alert fires permanently and blames "unexpected income" for
  // money the user just told us is on its way out.
  const balanceDeltaCents =
    liveBalance != null
      ? liveBalance - (projectedTodayCents + pendingPosting.totalHeldCents)
      : null;
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
          label="Available to plan"
          value={<Money cents={currentBalanceCents} />}
          variant={balanceVariant(currentBalanceCents)}
          delta={
            inFlightCents > 0 ? (
              <>
                posted <Money cents={postedNowCents} /> · <Money cents={inFlightCents} /> in flight
              </>
            ) : liveBalance != null ? (
              "live · linked accounts"
            ) : (
              "projected as of today"
            )
          }
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

      <PendingPostingAlert
        occurrences={unpaidRecentOccurrences}
        answered={pendingPosting.answered}
        cardPayments={pendingPosting.cardPayments}
        totalHeldCents={pendingPosting.totalHeldCents}
        unattributedCents={pendingPosting.unattributedCents}
        today={today}
      />

      {uncoveredCardDues.length > 0 ? (
        <AlertBar tag="Interest" variant={uncoveredDueUrgent ? "red" : "amber"}>
          No planned payment covers{" "}
          {uncoveredCardDues.slice(0, 3).map((d, i) => (
            <span key={`${d.cardId}-${d.dueDate}`}>
              {i > 0 ? ", " : ""}
              <strong className={uncoveredDueUrgent ? "text-[var(--red)]" : "text-[var(--amber)]"}>
                {d.label}
              </strong>{" "}
              (<Money cents={d.shortfallCents} />
              {d.coverCents > 0 ? <> of <Money cents={d.owedCents} /> uncovered</> : null}
              {d.overdueSinceDate ? (
                <>
                  {" "}
                  overdue since <DateLabel iso={d.overdueSinceDate} format="short" />
                </>
              ) : (
                <>
                  {" "}
                  due <DateLabel iso={d.dueDate} format="short" />
                </>
              )}
              )
            </span>
          ))}
          {uncoveredCardDues.length > 3 ? ` and ${uncoveredCardDues.length - 3} more` : ""}
          . Balances left uncovered past the due date accrue interest.{" "}
          <Link href="/calendar" className="text-[var(--mint)] hover:underline">
            Schedule a payment →
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
          <ProjectionChart
            data={rows.map((r) => ({
              date: r.date,
              balanceCents: r.balanceCents,
              // Sparse by design — only where the bank's view differs, so the
              // dashed line spans the in-flight window and stops at today.
              postedBalanceCents: showsPostedBalance(r, today) ? r.postedBalanceCents : null,
            }))}
          />
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
                      <span className="flex items-baseline gap-1.5">
                        {showsPostedBalance(row, today) ? (
                          <span
                            className="tabular text-2xs text-[var(--text-3)] line-through"
                            title="Posted balance — what the bank shows before money in flight clears"
                          >
                            <Money cents={row.postedBalanceCents} />
                          </span>
                        ) : null}
                        <span
                          className={cn("tabular text-2xs font-semibold", balanceClass(row.balanceCents))}
                        >
                          <Money cents={row.balanceCents} />
                        </span>
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
