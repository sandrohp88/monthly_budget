"use client";

// Per-card detail page: everything that used to crowd the wallet view —
// current statement, history, cycle estimate, deferred-interest promos, and
// card settings — lives here, behind a click on the card.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  ClipboardPaste,
  FileText,
  Plus,
  Scale,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/status-pill";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import { CreditCardVisual } from "@/components/credit-card-visual";
import { InlineBalanceEditor } from "@/components/inline-balance-editor";
import { PromoReconcileDialog } from "@/components/promo-reconcile-dialog";
import { cardDisplayName, cardMaskDigits } from "@/lib/card-art";
import {
  LinkedBillEstimate,
  currentStatementOf,
  daysBetween,
  interestSavingCashDueCents,
  isStatementOpen,
  nextStatementDateOnOrAfter,
  paidWithoutInterest,
  promoMonthlyChunkAt,
  summarizeStatementBalances,
} from "@/lib/credit-cards";
import { todayIso } from "@/lib/dates";
import { cn } from "@/lib/cn";
import type {
  CreditCardPromoRow,
  CreditCardRow,
  CreditCardStatementRow,
} from "@/lib/db/schema";
import {
  CardDialog,
  PromoDialog,
  PromoScheduleSheet,
  PromoWhatIfSheet,
  StatementCreateDialog,
  StatementEditDialog,
  type PromoScheduledPayment,
} from "../card-dialogs";

export type CycleEstimate = {
  window: { start: string; end: string };
  charges: LinkedBillEstimate[];
  totalCents: number;
};

function statementCycleLabel(card: CreditCardRow): string {
  if (card.statementCycleMode === "interval_days") {
    return `Statement every ${card.statementCycleIntervalDays} days`;
  }
  return `Statement day ${card.statementDay}`;
}

export function CardDetailClient({
  card,
  statements,
  promos,
  estimate,
  linkedBillCount,
  paymentsByPromoId,
  scheduledCardPayments,
  mask,
  institution,
  accountBalanceCents,
}: {
  card: CreditCardRow;
  statements: CreditCardStatementRow[];
  promos: CreditCardPromoRow[];
  estimate: CycleEstimate | null;
  linkedBillCount: number;
  paymentsByPromoId: Record<string, PromoScheduledPayment[]>;
  /** Pending calendar paydowns on this card (credit the promo balance). */
  scheduledCardPayments: Array<{ date: string; amountCents: number }>;
  mask: string | null;
  institution: string | null;
  accountBalanceCents: number | null;
}) {
  const router = useRouter();
  const today = todayIso();

  const [editOpen, setEditOpen] = React.useState(false);
  const [statementOpen, setStatementOpen] = React.useState(false);
  const [editStatement, setEditStatement] = React.useState<CreditCardStatementRow | null>(null);
  const [createPromoOpen, setCreatePromoOpen] = React.useState(false);
  const [editPromo, setEditPromo] = React.useState<CreditCardPromoRow | null>(null);
  const [whatIfPromo, setWhatIfPromo] = React.useState<CreditCardPromoRow | null>(null);
  const [whatIfAll, setWhatIfAll] = React.useState(false);
  const [schedulePromo, setSchedulePromo] = React.useState<CreditCardPromoRow | null>(null);
  const [reconcileOpen, setReconcileOpen] = React.useState(false);

  const refresh = () => router.refresh();

  const archiveCard = async () => {
    if (!confirm("Archive this card? Statement history is kept.")) return;
    const res = await fetch(`/api/credit-cards/${card.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Archive failed");
      return;
    }
    toast.success("Card archived");
    router.push("/credit-cards");
    router.refresh();
  };

  const name = cardDisplayName(card.name, institution);
  const digits = cardMaskDigits(card.name, mask);

  const activePromos = promos.filter((p) => p.isActive && p.remainingAmountCents > 0);
  const promoRemainingCents = activePromos.reduce((s, p) => s + p.remainingAmountCents, 0);
  // Calendar paydowns are applied to the card and then credited against the
  // promo balance, so promo schedules can be fully/partly covered before they
  // reach the calendar. Surface that in the planner instead of leaving the user
  // to wonder why their promo payments don't show.
  const scheduledCardPaymentCents = scheduledCardPayments.reduce((s, p) => s + p.amountCents, 0);
  const promoLeftToCoverCents = Math.max(0, promoRemainingCents - scheduledCardPaymentCents);

  const openStatements = statements.filter(isStatementOpen);
  // Cash needed to avoid interest — the Interest Saving Balance when the card
  // has active 0% promos, the full statement cash due otherwise.
  const openDueCents = openStatements.reduce(
    (s, x) => s + interestSavingCashDueCents(x, activePromos),
    0,
  );
  const balanceCents =
    card.currentBalanceCents ??
    accountBalanceCents ??
    (statements.length > 0 || promoRemainingCents > 0
      ? openDueCents + promoRemainingCents
      : null);

  // Current statement state — the page's headline: what to pay to avoid interest.
  const current = currentStatementOf(statements);
  const isOpen = current ? isStatementOpen(current) : false;
  const days = current ? daysBetween(today, current.dueDate) : null;
  const safe = current ? paidWithoutInterest(current, activePromos) : false;

  const summary = React.useMemo(
    () => summarizeStatementBalances(statements, today),
    [statements, today],
  );
  const hasSummary =
    card.plaidAccountId != null &&
    (summary.lastClosedCents != null ||
      summary.avg3MoCents != null ||
      summary.avg6MoCents != null ||
      summary.avg12MoCents != null);

  return (
    <div className="space-y-6 fade-in">
      <Link
        href="/credit-cards"
        className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-3)] transition-colors hover:text-[var(--text-1)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> CREDIT CARDS
      </Link>

      {/* ── hero: the card + identity + balance + actions ─────────────────── */}
      <div className="flex flex-col gap-6 md:flex-row md:items-start md:gap-9">
        <div className="w-full max-w-[340px] shrink-0">
          <CreditCardVisual
            name={card.name}
            institution={institution}
            mask={mask}
            className="shadow-[var(--shadow-md)]"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[26px] font-extrabold leading-tight text-[var(--text-0)] md:text-[30px]">
              {name}
            </h1>
            {!card.isActive ? <StatusPill variant="off">ARCHIVED</StatusPill> : null}
            {card.plaidAccountId ? <StatusPill>LINKED</StatusPill> : null}
          </div>
          <div className="mt-1.5 text-[13px] text-[var(--text-2)]">
            {digits ? (
              <span className="mr-2 tracking-[0.12em] tabular">•••• {digits}</span>
            ) : null}
            {statementCycleLabel(card)} · Due day {card.dueDay}
            {card.autoPay ? " · Autopay" : ""}
          </div>

          <div className="mt-5 flex flex-wrap items-end gap-x-10 gap-y-4">
            <div>
              <div className="mb-1 text-[12px] font-medium text-[var(--text-2)]">
                CURRENT BALANCE
              </div>
              <div className="text-[32px] font-bold leading-none tracking-tight tabular text-[var(--text-0)]">
                {card.plaidAccountId == null ? (
                  <InlineBalanceEditor
                    cardId={card.id}
                    valueCents={balanceCents}
                    inputClassName="h-10 w-40 text-[22px]"
                  />
                ) : balanceCents != null ? (
                  <Money cents={balanceCents} />
                ) : (
                  <span className="text-[var(--text-3)]">—</span>
                )}
              </div>
            </div>
            {promoRemainingCents > 0 ? (
              <div>
                <div className="mb-1 text-[12px] font-medium text-[var(--text-2)]">
                  PROMO BALANCE
                </div>
                <div className="text-[20px] font-bold leading-none tabular text-[var(--cyan)]">
                  <Money cents={promoRemainingCents} />
                </div>
              </div>
            ) : null}
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              EDIT CARD
            </Button>
            <Button size="sm" variant="outline" onClick={() => setStatementOpen(true)}>
              <FileText className="h-3 w-3" /> ENTER STATEMENT
            </Button>
            {card.isActive ? (
              <Button size="sm" variant="ghost" onClick={archiveCard} title="Archive card">
                <Trash2 className="h-3 w-3" /> ARCHIVE
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {/* ── payment due: the headline question ────────────────────────────── */}
      <Card>
        <CardContent className="py-5">
          {current == null ? (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="mb-1 text-[12px] font-medium text-[var(--text-2)]">
                  DUE TO AVOID INTEREST
                </div>
                <div className="text-[14px] text-[var(--text-2)]">
                  No statement yet — next expected{" "}
                  <span className="font-semibold text-[var(--text-0)]">
                    <DateLabel iso={nextStatementDateOnOrAfter(today, card)} format="short" />
                  </span>
                </div>
              </div>
              <Button variant="primary" onClick={() => setStatementOpen(true)}>
                <FileText className="h-3 w-3" /> ENTER STATEMENT
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="mb-1 flex items-center gap-2 text-[12px] font-medium text-[var(--text-2)]">
                  {isOpen ? "DUE TO AVOID INTEREST" : "LAST PAID"}
                  {isOpen ? (
                    days != null && days < 0 ? (
                      <StatusPill variant="danger">{`${Math.abs(days)}D OVERDUE`}</StatusPill>
                    ) : days != null && days <= 7 ? (
                      <StatusPill variant="warn">{`DUE IN ${days}D`}</StatusPill>
                    ) : (
                      <StatusPill>{`DUE IN ${days}D`}</StatusPill>
                    )
                  ) : safe ? (
                    <StatusPill>
                      <CheckCircle2 className="mr-1 inline h-3 w-3 -mt-px" />
                      ON TIME
                    </StatusPill>
                  ) : (
                    <StatusPill variant="warn">PAID LATE</StatusPill>
                  )}
                </div>
                <div
                  className={cn(
                    "text-[30px] font-bold leading-none tracking-tight tabular",
                    isOpen
                      ? days != null && days < 0
                        ? "text-[var(--red)]"
                        : days != null && days <= 7
                          ? "text-[var(--amber)]"
                          : "text-[var(--text-0)]"
                      : safe
                        ? "text-[var(--mint)]"
                        : "text-[var(--amber)]",
                  )}
                >
                  <Money cents={interestSavingCashDueCents(current, activePromos)} />
                </div>
                <div className="mt-1.5 text-[12px] text-[var(--text-2)]">
                  Closed <DateLabel iso={current.statementDate} format="short" /> · Due{" "}
                  <span className="font-semibold text-[var(--text-0)]">
                    <DateLabel iso={current.dueDate} format="short" />
                  </span>
                  {!isOpen && current.paidDate ? (
                    <>
                      {" · Paid "}
                      <span className={safe ? "text-[var(--mint)]" : "text-[var(--amber)]"}>
                        <DateLabel iso={current.paidDate} format="short" />
                      </span>
                    </>
                  ) : null}
                </div>
              </div>
              {isOpen ? (
                <Button variant="primary" onClick={() => setEditStatement(current)}>
                  MARK PAID
                </Button>
              ) : (
                <Button variant="outline" onClick={() => setStatementOpen(true)}>
                  <FileText className="h-3 w-3" /> NEW STATEMENT
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* ── expected charges this cycle ─────────────────────────────────── */}
        {linkedBillCount > 0 && estimate ? (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Expected this cycle</CardTitle>
                <CardDescription>
                  <DateLabel iso={estimate.window.start} format="short" />
                  {" – "}
                  <DateLabel iso={estimate.window.end} format="short" /> · {linkedBillCount} linked
                  item{linkedBillCount === 1 ? "" : "s"}
                </CardDescription>
              </div>
              <div className="text-[20px] font-bold tabular text-[var(--text-0)]">
                <Money cents={estimate.totalCents} />
              </div>
            </CardHeader>
            <CardContent className="pt-4">
              {estimate.charges.length > 0 ? (
                <table className="w-full text-[12px] tabular">
                  <tbody>
                    {estimate.charges
                      .slice()
                      .sort((a, b) => a.date.localeCompare(b.date))
                      .map((c) => (
                        <tr
                          key={`${c.sourceType}-${c.sourceId}-${c.date}`}
                          className="border-b border-[var(--border-raw)] last:border-0"
                        >
                          <td className="py-1.5 pr-2 text-[var(--text-2)]">
                            <DateLabel iso={c.date} format="short" />
                          </td>
                          <td className="max-w-[180px] truncate py-1.5 pr-2 text-[var(--text-1)]">
                            {c.name}
                          </td>
                          <td className="py-1.5 text-right text-[var(--text-0)]">
                            <Money cents={c.amountCents} />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              ) : (
                <div className="text-[12px] text-[var(--text-3)]">
                  No linked spend falls in this cycle window
                </div>
              )}
              {current && isOpen ? (
                <ActualVsEstimate
                  actualCents={interestSavingCashDueCents(current, activePromos)}
                  estimatedCents={estimate.totalCents}
                />
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {/* ── statement history ───────────────────────────────────────────── */}
        <Card className={cn(!(linkedBillCount > 0 && estimate) && "lg:col-span-2")}>
          <CardHeader>
            <div>
              <CardTitle>Statements</CardTitle>
              <CardDescription>
                {statements.length === 0
                  ? "No statements recorded yet"
                  : `${statements.length} recorded · click a row to edit or mark paid`}
              </CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={() => setStatementOpen(true)}>
              <Plus className="h-3 w-3" /> NEW
            </Button>
          </CardHeader>
          <CardContent className="pt-2">
            {hasSummary ? (
              <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <SummaryStat
                  label="LAST STMT"
                  cents={summary.lastClosedCents}
                  sub={
                    summary.lastClosedDate ? (
                      <DateLabel iso={summary.lastClosedDate} format="short" />
                    ) : (
                      "—"
                    )
                  }
                />
                <SummaryStat
                  label="3M AVG"
                  cents={summary.avg3MoCents}
                  sub={`${summary.avg3MoCount} stmt${summary.avg3MoCount === 1 ? "" : "s"}`}
                />
                <SummaryStat
                  label="6M AVG"
                  cents={summary.avg6MoCents}
                  sub={`${summary.avg6MoCount} stmt${summary.avg6MoCount === 1 ? "" : "s"}`}
                />
                <SummaryStat
                  label="12M AVG"
                  cents={summary.avg12MoCents}
                  sub={`${summary.avg12MoCount} stmt${summary.avg12MoCount === 1 ? "" : "s"}`}
                />
              </div>
            ) : null}
            {statements.length > 0 ? (
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-[12px] tabular">
                  <thead>
                    <tr className="border-b border-[var(--border-raw)] text-left text-[11px] font-medium text-[var(--text-3)]">
                      <th className="py-1.5 pr-2 font-medium">CLOSED</th>
                      <th className="py-1.5 pr-2 text-right font-medium">BALANCE</th>
                      <th className="py-1.5 pr-2 font-medium">DUE</th>
                      <th className="py-1.5 text-right font-medium">STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statements.map((s) => {
                      const ok = paidWithoutInterest(s, activePromos);
                      return (
                        <tr
                          key={s.id}
                          className="cursor-pointer border-b border-[var(--border-raw)] transition-colors last:border-0 hover:bg-[var(--bg-2)]"
                          onClick={() => setEditStatement(s)}
                        >
                          <td className="py-2 pr-2 text-[var(--text-1)]">
                            <DateLabel iso={s.statementDate} format="short" />
                          </td>
                          <td className="py-2 pr-2 text-right text-[var(--text-0)]">
                            <Money cents={s.statementBalanceCents} />
                          </td>
                          <td className="py-2 pr-2 text-[var(--text-2)]">
                            <DateLabel iso={s.dueDate} format="short" />
                          </td>
                          <td className="py-2 text-right">
                            {isStatementOpen(s) ? (
                              <span
                                className={cn(
                                  "font-semibold",
                                  s.dueDate < today ? "text-[var(--red)]" : "text-[var(--amber)]",
                                )}
                              >
                                {s.dueDate < today ? "OVERDUE" : "UNPAID"}
                              </span>
                            ) : ok ? (
                              <span className="font-semibold text-[var(--mint)]">PAID</span>
                            ) : (
                              <span className="font-semibold text-[var(--amber)]">LATE</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="py-4 text-center text-[12px] text-[var(--text-3)]">
                Enter a statement to start tracking what&apos;s due.
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── deferred-interest promos ────────────────────────────────────── */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 text-[var(--cyan)]" />
                Deferred-interest promos
                {activePromos.length > 0 ? (
                  <span className="text-[var(--text-3)]">({activePromos.length})</span>
                ) : null}
              </CardTitle>
              <CardDescription>
                No interest only when paid in full by each deadline — missing one may trigger
                interest back to the purchase date.
              </CardDescription>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setReconcileOpen(true)}
                title="Reconcile from a pasted issuer promo list (PayPal page or Chase statement table)"
              >
                <ClipboardPaste className="h-3 w-3" /> RECONCILE
              </Button>
              <Button size="sm" variant="outline" onClick={() => setCreatePromoOpen(true)}>
                <Plus className="h-3 w-3" /> ADD
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            {activePromos.length === 0 ? (
              <div className="text-[12px] text-[var(--text-3)]">
                No active promos. Track no-interest-if-paid-in-full financing across cycles.
              </div>
            ) : (
              <>
                <div className="mb-3 flex items-baseline justify-between">
                  <span className="text-[20px] font-bold tabular text-[var(--text-0)]">
                    <Money cents={promoRemainingCents} />
                  </span>
                  <span className="text-[11px] font-medium text-[var(--text-3)]">REMAINING</span>
                </div>

                {scheduledCardPaymentCents > 0 ? (
                  <div className="mb-3 rounded-[10px] border border-[var(--cyan)]/40 bg-[var(--cyan)]/5 px-3 py-2.5 text-[11px] leading-relaxed text-[var(--text-2)]">
                    <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cyan)]">
                      <CalendarDays className="h-3 w-3" /> Scheduled on calendar
                    </div>
                    <span className="font-semibold tabular text-[var(--text-0)]">
                      <Money cents={scheduledCardPaymentCents} />
                    </span>{" "}
                    in card payment{scheduledCardPayments.length === 1 ? " is" : "s are"} planned (
                    {scheduledCardPayments.map((p, i) => (
                      <React.Fragment key={p.date}>
                        {i > 0 ? ", " : ""}
                        <DateLabel iso={p.date} format="short" />
                      </React.Fragment>
                    ))}
                    ).{" "}
                    {promoLeftToCoverCents === 0 ? (
                      <>
                        That covers this card&apos;s full promo balance, so promo payment plans
                        below are absorbed by those payments and won&apos;t show separately on the
                        calendar.
                      </>
                    ) : (
                      <>
                        They cover part of the promo balance —{" "}
                        <span className="font-semibold tabular text-[var(--text-0)]">
                          <Money cents={promoLeftToCoverCents} />
                        </span>{" "}
                        still to plan.
                      </>
                    )}
                  </div>
                ) : null}

                <ul className="space-y-1.5">
                  {activePromos.map((p) => {
                    const sched = paymentsByPromoId[p.id] ?? [];
                    const hasManualSchedule = sched.length > 0;
                    const chunk = hasManualSchedule
                      ? (sched.find((s) => s.dueDate >= today)?.amountCents ?? 0)
                      : promoMonthlyChunkAt(p, today);
                    const daysLeft = daysBetween(today, p.endDate);
                    const tone =
                      daysLeft < 0
                        ? "text-[var(--red)]"
                        : daysLeft <= 30
                          ? "text-[var(--amber)]"
                          : "text-[var(--text-1)]";
                    return (
                      <li
                        key={p.id}
                        className="flex items-center justify-between gap-2 rounded-[10px] border border-[var(--border-raw)] bg-[var(--bg-1)] px-3 py-2"
                      >
                        <button
                          type="button"
                          onClick={() => setEditPromo(p)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="flex items-center gap-1.5 truncate text-[13px] text-[var(--text-0)]">
                            <span className="truncate">{p.description}</span>
                            {hasManualSchedule ? (
                              <span className="shrink-0 rounded-full border border-[var(--cyan)] px-1.5 py-[1px] text-[9px] font-bold tracking-wide text-[var(--cyan)]">
                                PLAN
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 text-[11px] text-[var(--text-2)]">
                            <span className="font-semibold tabular text-[var(--text-1)]">
                              <Money cents={chunk} />
                            </span>
                            {hasManualSchedule
                              ? ` next · ${sched.length} planned · ends `
                              : "/mo · ends "}
                            <span className={tone}>
                              <DateLabel iso={p.endDate} format="short" />
                            </span>
                          </div>
                        </button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSchedulePromo(p)}
                          title={
                            hasManualSchedule
                              ? "Edit payment schedule"
                              : "Set custom payment schedule"
                          }
                        >
                          <CalendarDays className="h-3 w-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setWhatIfPromo(p)}
                          title="What-if comparison"
                        >
                          <Scale className="h-3 w-3" />
                        </Button>
                      </li>
                    );
                  })}
                </ul>

                {activePromos.length > 1 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={() => setWhatIfAll(true)}
                  >
                    <Scale className="h-3 w-3" /> COMPARE PAY ALL VS SCHEDULE
                  </Button>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── dialogs ───────────────────────────────────────────────────────── */}
      {editOpen ? (
        <CardDialog
          card={card}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            refresh();
          }}
        />
      ) : null}
      {statementOpen ? (
        <StatementCreateDialog
          card={card}
          existingStatements={statements}
          onClose={() => setStatementOpen(false)}
          onSaved={() => {
            setStatementOpen(false);
            refresh();
          }}
        />
      ) : null}
      {editStatement ? (
        <StatementEditDialog
          statement={editStatement}
          promos={activePromos}
          onClose={() => setEditStatement(null)}
          onSaved={() => {
            setEditStatement(null);
            refresh();
          }}
        />
      ) : null}
      {createPromoOpen ? (
        <PromoDialog
          card={card}
          onClose={() => setCreatePromoOpen(false)}
          onSaved={() => {
            setCreatePromoOpen(false);
            refresh();
          }}
        />
      ) : null}
      {editPromo ? (
        <PromoDialog
          card={card}
          promo={editPromo}
          onClose={() => setEditPromo(null)}
          onSaved={() => {
            setEditPromo(null);
            refresh();
          }}
        />
      ) : null}
      {whatIfPromo ? (
        <PromoWhatIfSheet
          scope="promo"
          card={card}
          promos={[whatIfPromo]}
          paymentsByPromoId={paymentsByPromoId}
          onClose={() => setWhatIfPromo(null)}
        />
      ) : null}
      {whatIfAll ? (
        <PromoWhatIfSheet
          scope="card"
          card={card}
          promos={activePromos}
          paymentsByPromoId={paymentsByPromoId}
          onClose={() => setWhatIfAll(false)}
        />
      ) : null}
      {schedulePromo ? (
        <PromoScheduleSheet
          card={card}
          promo={schedulePromo}
          initialPayments={paymentsByPromoId[schedulePromo.id] ?? []}
          scheduledCardPaymentCents={scheduledCardPaymentCents}
          onClose={() => setSchedulePromo(null)}
          onSaved={() => {
            setSchedulePromo(null);
            refresh();
          }}
        />
      ) : null}
      {reconcileOpen ? (
        <PromoReconcileDialog
          card={{ id: card.id, name: card.name }}
          promos={promos}
          onClose={() => setReconcileOpen(false)}
          onApplied={() => {
            setReconcileOpen(false);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

// Small inline diff between the real statement balance and the bill-derived
// estimate. Useful sanity check — large positive deltas mean discretionary
// spend on top of recurring bills; large negative deltas mean an expected
// bill didn't post yet (or got paid via cash).
function ActualVsEstimate({
  actualCents,
  estimatedCents,
}: {
  actualCents: number;
  estimatedCents: number;
}) {
  if (estimatedCents === 0) return null;
  const delta = actualCents - estimatedCents;
  const tone =
    Math.abs(delta) <= Math.max(500, estimatedCents * 0.05) // within $5 or 5%
      ? "text-[var(--mint)]"
      : delta > 0
        ? "text-[var(--amber)]"
        : "text-[var(--text-2)]";
  return (
    <div className="mt-3 flex items-center justify-between border-t border-[var(--border-raw)] pt-2.5 text-[11px] font-medium text-[var(--text-3)]">
      <span>VS CURRENT STATEMENT</span>
      <span className={cn("tabular", tone)}>
        {delta >= 0 ? "+" : "−"}
        <Money cents={Math.abs(delta)} />
      </span>
    </div>
  );
}

function SummaryStat({
  label,
  cents,
  sub,
}: {
  label: string;
  cents: number | null;
  sub: React.ReactNode;
}) {
  return (
    <div className="rounded-[10px] border border-[var(--border-raw)] bg-[var(--bg-1)] px-2.5 py-2">
      <div className="mb-0.5 text-[10px] font-medium tracking-wide text-[var(--text-3)]">
        {label}
      </div>
      <div className="text-[14px] font-bold leading-none tabular text-[var(--text-0)]">
        {cents == null ? <span className="text-[var(--text-3)]">—</span> : <Money cents={cents} />}
      </div>
      <div className="mt-1 text-[10px] text-[var(--text-3)]">{sub}</div>
    </div>
  );
}
