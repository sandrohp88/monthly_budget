"use client";

import * as React from "react";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CalendarDays,
  CreditCard,
  ReceiptText,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CardSubTag } from "@/components/ui/page-head";
import { Money } from "@/components/money";
import { MoneyInput } from "@/components/money-input";
import { DateLabel } from "@/components/date-label";
import type { ProjectionEvent, ProjectionRow } from "@/lib/projection";
import { addDaysIso, startOfMonthIso } from "@/lib/dates";
import { cn } from "@/lib/cn";

// ─────────────────────────────────────────────────────────────────────────────
// Filter
// ─────────────────────────────────────────────────────────────────────────────

type FilterKey = "ALL" | "MONTH" | "3M" | "6M" | "1Y";

const FILTERS: ReadonlyArray<{ key: FilterKey; label: string }> = [
  { key: "MONTH", label: "This month" },
  { key: "3M", label: "3 months" },
  { key: "6M", label: "6 months" },
  { key: "1Y", label: "1 year" },
  { key: "ALL", label: "All" },
];

const NEGATIVE_BALANCE_TOOLTIP =
  "Projected balance is negative after this day's income and expenses. The payments due by this row exceed the cash available to pay them.";

/** Last day of the month containing isoDate, in YYYY-MM-DD. */
function endOfMonth(isoDate: string): string {
  const [yStr, mStr] = isoDate.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${yStr}-${mStr}-${String(lastDay).padStart(2, "0")}`;
}

function minIso(a: string, b: string): string {
  return a < b ? a : b;
}

function maxIso(a: string, b: string): string {
  return a > b ? a : b;
}

function rangeForFilter(
  filter: FilterKey,
  today: string,
  fullStart: string,
  fullEnd: string,
): { start: string; end: string } {
  if (filter === "ALL") return { start: fullStart, end: fullEnd };
  const start = filter === "MONTH" ? maxIso(startOfMonthIso(today), fullStart) : today;
  if (filter === "MONTH") return { start, end: minIso(endOfMonth(today), fullEnd) };
  const days = filter === "3M" ? 90 : filter === "6M" ? 180 : 365;
  return { start, end: minIso(addDaysIso(today, days), fullEnd) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function balanceClass(cents: number) {
  if (cents < 0) return "text-[var(--red)]";
  if (cents < 50000) return "text-[var(--amber)]";
  return "text-[var(--phosphor)]";
}

type LedgerSection = {
  key: string;
  sourceDate?: string;
  sourceLabel: string;
  sourceAmountCents: number;
  expenseCents: number;
  billCount: number;
  rows: ProjectionRow[];
  isOpeningBalance: boolean;
};

type PaymentAdjustment = {
  targetType: "bill" | "creditCardPayment";
  targetId: string;
  targetName: string;
  dueDate: string;
  relatedDate?: string;
  amountCents: number;
  originalAmountCents: number;
  paymentDueCents?: number;
  paymentBalanceCents?: number;
  promoSummaries?: PromoPaymentSummary[];
};

type PromoPaymentSummary = {
  id: string;
  cardId: string;
  description: string;
  remainingAmountCents: number;
  endDate: string;
  monthlyPaymentCents: number | null;
};

type LedgerSummary = {
  openingBalanceCents: number;
  closingBalanceCents: number;
  netDeltaCents: number;
  totalIncomeCents: number;
  totalExpenseCents: number;
  eventCount: number;
  cardEventCount: number;
  negativeDayCount: number;
  lowPoint: ProjectionRow | null;
  nextEvent: ProjectionRow | null;
};

type SoftPillTone = "neutral" | "income" | "danger" | "warning";

function hasPaycheck(row: ProjectionRow): boolean {
  return row.events.some((event) => event.kind === "paycheck");
}

function paycheckAmount(row: ProjectionRow): number {
  return row.events
    .filter((event) => event.kind === "paycheck")
    .reduce((total, event) => total + event.amountCents, 0);
}

function paycheckLabel(row: ProjectionRow): string {
  return row.events
    .filter((event) => event.kind === "paycheck")
    .map((event) => event.label)
    .join(" + ");
}

function buildLedgerSections(rows: ProjectionRow[]): LedgerSection[] {
  const sections: LedgerSection[] = [];
  let current: LedgerSection = {
    key: "opening-balance",
    sourceLabel: "OPENING BALANCE",
    sourceAmountCents: 0,
    expenseCents: 0,
    billCount: 0,
    rows: [],
    isOpeningBalance: true,
  };

  for (const row of rows) {
    if (hasPaycheck(row)) {
      if (current.rows.length > 0) sections.push(current);
      current = {
        key: `paycheck-${row.date}`,
        sourceDate: row.date,
        sourceLabel: paycheckLabel(row) || "PAYCHECK",
        sourceAmountCents: paycheckAmount(row),
        expenseCents: 0,
        billCount: 0,
        rows: [],
        isOpeningBalance: false,
      };
    }

    current.rows.push(row);
    current.expenseCents += row.expenseCents;
    current.billCount += row.events.filter((event) => event.kind === "bill").length;
  }

  if (current.rows.length > 0) sections.push(current);
  return sections;
}

function buildLedgerSummary(
  windowRows: ProjectionRow[],
  eventRows: ProjectionRow[],
  today: string,
): LedgerSummary {
  const firstRow = windowRows[0] ?? null;
  const lastRow = windowRows[windowRows.length - 1] ?? null;
  const openingBalanceCents = firstRow
    ? firstRow.balanceCents - firstRow.incomeCents + firstRow.expenseCents
    : 0;
  const closingBalanceCents = lastRow?.balanceCents ?? openingBalanceCents;
  const lowPoint =
    windowRows.length === 0
      ? null
      : windowRows.reduce((lowest, row) => (row.balanceCents < lowest.balanceCents ? row : lowest));
  const nextEvent = eventRows.find((row) => row.date >= today) ?? eventRows[0] ?? null;

  return {
    openingBalanceCents,
    closingBalanceCents,
    netDeltaCents: closingBalanceCents - openingBalanceCents,
    totalIncomeCents: windowRows.reduce((total, row) => total + row.incomeCents, 0),
    totalExpenseCents: windowRows.reduce((total, row) => total + row.expenseCents, 0),
    eventCount: eventRows.reduce((total, row) => total + row.events.length, 0),
    cardEventCount: eventRows.reduce(
      (total, row) =>
        total + row.events.filter((event) => event.sourceType === "creditCardPayment").length,
      0,
    ),
    negativeDayCount: windowRows.filter((row) => row.balanceCents < 0).length,
    lowPoint,
    nextEvent,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function ProjectionClient({
  rows,
  startDate,
  endDate,
  today,
  promoSummariesByCard,
  variableBillCategories = {},
}: {
  rows: ProjectionRow[];
  startDate: string;
  endDate: string;
  today: string;
  promoSummariesByCard: Record<string, PromoPaymentSummary[]>;
  variableBillCategories?: Record<string, string[]>;
}) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<FilterKey>("ALL");
  const [cardsOnly, setCardsOnly] = React.useState(false);
  const [adjustingPayment, setAdjustingPayment] = React.useState<PaymentAdjustment | null>(null);
  const [savingAdjustment, setSavingAdjustment] = React.useState(false);

  const range = React.useMemo(
    () => rangeForFilter(filter, today, startDate, endDate),
    [filter, today, startDate, endDate],
  );

  // All rows in the filter window (every day, including no-event days).
  const windowRows = React.useMemo(
    () => rows.filter((r) => r.date >= range.start && r.date <= range.end),
    [rows, range.start, range.end],
  );

  // The visible ledger rows — only days where money moved.
  // When `cardsOnly` is on, strip non-card events from each row and drop rows
  // that have nothing card-related. The balance column still reflects the
  // full projected balance (paychecks + bills are still in the ledger
  // computation upstream), so the view stays useful as a cash-flow check.
  const eventRows = React.useMemo(() => {
    const all = windowRows.filter((r) => r.events.length > 0);
    if (!cardsOnly) return all;
    return all
      .map((r) => ({
        ...r,
        events: r.events.filter((e) => e.sourceType === "creditCardPayment"),
      }))
      .filter((r) => r.events.length > 0);
  }, [windowRows, cardsOnly]);
  const ledgerSections = React.useMemo(() => buildLedgerSections(eventRows), [eventRows]);
  const summary = React.useMemo(
    () => buildLedgerSummary(windowRows, eventRows, today),
    [windowRows, eventRows, today],
  );

  const overridePath = (adjustment: PaymentAdjustment) =>
    adjustment.targetType === "bill"
      ? `/api/bills/${adjustment.targetId}/payment-overrides`
      : `/api/credit-cards/${adjustment.targetId}/payment-overrides`;

  const deleteOverride = async (adjustment: PaymentAdjustment, dueDate: string) => {
    const qs = new URLSearchParams({ dueDate });
    const res = await fetch(`${overridePath(adjustment)}?${qs}`, { method: "DELETE" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "reset failed");
  };

  const putOverride = async (
    adjustment: PaymentAdjustment,
    dueDate: string,
    amountCents: number,
    notes?: string | null,
  ) => {
    const body: { dueDate: string; amountCents: number; notes?: string | null } = {
      dueDate,
      amountCents,
    };
    if (notes !== undefined) body.notes = notes;
    const res = await fetch(overridePath(adjustment), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "save failed");
  };

  const savePaymentAdjustment = async (
    adjustment: PaymentAdjustment,
    amountCents: number,
    plannedDate: string,
  ) => {
    setSavingAdjustment(true);
    try {
      const originalDate = adjustment.relatedDate ?? adjustment.dueDate;
      const movedCardPayment =
        adjustment.targetType === "creditCardPayment" && plannedDate !== originalDate;
      if (movedCardPayment) {
        await putOverride(adjustment, originalDate, 0, `moved-to:${plannedDate}`);
        await putOverride(adjustment, plannedDate, amountCents, `moved-from:${originalDate}`);
        if (adjustment.dueDate !== originalDate && adjustment.dueDate !== plannedDate) {
          await deleteOverride(adjustment, adjustment.dueDate);
        }
      } else if (amountCents === adjustment.originalAmountCents) {
        await deleteOverride(adjustment, adjustment.dueDate);
        if (adjustment.relatedDate && adjustment.relatedDate !== adjustment.dueDate) {
          await deleteOverride(adjustment, adjustment.relatedDate);
        }
      } else {
        await putOverride(adjustment, plannedDate, amountCents, null);
        if (adjustment.dueDate !== plannedDate) {
          await deleteOverride(adjustment, adjustment.dueDate);
        }
      }
      toast.success(
        amountCents === adjustment.originalAmountCents && !movedCardPayment
          ? "Planned payment reset"
          : "Planned payment updated",
      );
      setAdjustingPayment(null);
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSavingAdjustment(false);
    }
  };

  const resetPaymentAdjustment = async (adjustment: PaymentAdjustment) => {
    setSavingAdjustment(true);
    try {
      const dates = new Set(
        [adjustment.dueDate, adjustment.relatedDate].filter((date): date is string =>
          Boolean(date),
        ),
      );
      for (const dueDate of dates) {
        await deleteOverride(adjustment, dueDate);
      }
      toast.success("Planned payment reset");
      setAdjustingPayment(null);
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSavingAdjustment(false);
    }
  };

  return (
    <div className="space-y-4 font-sans">
      <section className="overflow-hidden rounded-[18px] border border-[var(--border-raw)] bg-[var(--bg-card)] shadow-[0_10px_30px_rgba(0,0,0,0.10)]">
        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.38fr)]">
          <div className="grid gap-px bg-[var(--border-raw)] sm:grid-cols-2 xl:grid-cols-4">
            <LedgerMetric
              icon={Wallet}
              label="Closing balance"
              value={<Money cents={summary.closingBalanceCents} />}
              tone={
                summary.closingBalanceCents < 0
                  ? "danger"
                  : summary.closingBalanceCents < 50000
                    ? "warn"
                    : "good"
              }
              detail={
                <>
                  Net {summary.netDeltaCents >= 0 ? "+" : "-"}
                  <Money cents={Math.abs(summary.netDeltaCents)} />
                </>
              }
            />
            <LedgerMetric
              icon={ArrowDownLeft}
              label="Money in"
              value={
                <>
                  +<Money cents={summary.totalIncomeCents} />
                </>
              }
              tone="good"
              detail={`${windowRows.length} projected days`}
            />
            <LedgerMetric
              icon={ArrowUpRight}
              label="Money out"
              value={
                <>
                  -<Money cents={summary.totalExpenseCents} />
                </>
              }
              tone="danger"
              detail={`${summary.eventCount} ledger events`}
            />
            <LedgerMetric
              icon={CalendarDays}
              label="Low water"
              value={<Money cents={summary.lowPoint?.balanceCents ?? 0} />}
              tone={(summary.lowPoint?.balanceCents ?? 0) < 0 ? "danger" : "warn"}
              detail={
                summary.lowPoint ? (
                  <DateLabel iso={summary.lowPoint.date} format="short" />
                ) : (
                  "no rows"
                )
              }
            />
          </div>
          <aside className="border-t border-[var(--border-raw)] bg-[var(--bg-2)] p-5 lg:border-t-0 lg:border-l">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-[15px] font-semibold text-[var(--text-0)]">Ledger window</div>
              <SoftPill tone={summary.negativeDayCount > 0 ? "danger" : "neutral"}>
                {summary.negativeDayCount} negative
              </SoftPill>
            </div>
            <div className="space-y-3 text-[13px] text-[var(--text-2)]">
              <div className="flex items-center justify-between gap-3">
                <span>Range</span>
                <span className="font-medium text-[var(--text-0)]">
                  <DateLabel iso={range.start} format="short" /> -{" "}
                  <DateLabel iso={range.end} format="short" />
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Opening</span>
                <span className="tabular font-semibold text-[var(--text-0)]">
                  <Money cents={summary.openingBalanceCents} />
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Card queue</span>
                <span className="tabular font-semibold text-[var(--text-0)]">
                  {summary.cardEventCount}
                </span>
              </div>
              <div className="flex items-start justify-between gap-3">
                <span>Next event</span>
                <span className="max-w-[14rem] text-right font-medium text-[var(--text-0)]">
                  {summary.nextEvent ? (
                    <>
                      <DateLabel iso={summary.nextEvent.date} format="short" />
                      {" / "}
                      {summary.nextEvent.events[0]?.label ?? "EVENT"}
                    </>
                  ) : (
                    "none"
                  )}
                </span>
              </div>
            </div>
          </aside>
        </div>
      </section>

      <div className="rounded-[16px] border border-[var(--border-raw)] bg-[var(--bg-card)] p-3 shadow-[0_1px_3px_rgba(0,0,0,0.08)]">
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <Tab key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
            </Tab>
          ))}
          <span className="mx-1 h-4 w-px bg-[var(--border-raw)]" aria-hidden />
          <Tab active={cardsOnly} onClick={() => setCardsOnly((v) => !v)}>
            Cards + promos
          </Tab>
          <div className="ml-auto text-[13px] text-[var(--text-2)]">
            {eventRows.length} row{eventRows.length === 1 ? "" : "s"} in view
          </div>
        </div>
      </div>

      <div className="max-h-[76vh] overflow-auto rounded-[18px] border border-[var(--border-raw)] bg-[var(--bg-card)] shadow-[0_10px_30px_rgba(0,0,0,0.10)]">
        <table className="tabular w-full text-[13px]">
          <thead className="sticky top-0 z-10 bg-[var(--bg-card)] shadow-[0_1px_0_var(--border-raw)]">
            <tr className="border-b border-[var(--border-raw)]">
              {["Date", "Description", "Money in", "Money out", "Balance"].map((h, i) => (
                <th
                  key={h}
                  className={cn(
                    "px-5 py-3 text-[12px] font-semibold text-[var(--text-3)]",
                    i >= 2 ? "text-right" : "text-left",
                  )}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {eventRows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-[14px] text-[var(--text-3)]">
                  {cardsOnly
                    ? "No credit-card or promo payments in this window."
                    : "No income or expense events in this window."}
                </td>
              </tr>
            ) : null}
            {ledgerSections.map((section, sectionIndex) => (
              <React.Fragment key={section.key}>
                {cardsOnly ? null : (
                  <PaycheckSectionHeader section={section} index={sectionIndex} />
                )}
                {section.rows.map((r) => {
                  const isPayday = hasPaycheck(r);
                  const isNegativeBalance = r.balanceCents < 0;
                  const rowClassBase = cn(
                    "transition-colors hover:bg-[var(--bg-2)]",
                    isNegativeBalance
                      ? "bg-[color-mix(in_oklch,var(--red)_8%,transparent)]"
                      : isPayday
                        ? "bg-[color-mix(in_oklch,var(--phosphor)_8%,transparent)]"
                        : "bg-transparent",
                  );
                  return (
                    <React.Fragment key={`${section.key}-${r.date}`}>
                      {r.events.map((event, eventIndex) => {
                        const isFirstEvent = eventIndex === 0;
                        const isLastEvent = eventIndex === r.events.length - 1;
                        // A paycheck is income. A negative-amount extra is
                        // also income (Plaid refund, return, statement
                        // credit). Everything else lands in the expense
                        // column.
                        const isRefundEvent = event.kind === "extra" && event.amountCents < 0;
                        const isIncomeEvent = event.kind === "paycheck" || isRefundEvent;
                        const isExpenseEvent = !isIncomeEvent;
                        const eventAbsCents = Math.abs(event.amountCents);
                        return (
                          <tr
                            id={isFirstEvent ? `d-${r.date}` : undefined}
                            key={`${section.key}-${r.date}-${event.kind}-${event.label}-${eventIndex}`}
                            className={cn(
                              rowClassBase,
                              isLastEvent
                                ? "border-b border-[var(--border-raw)]"
                                : "border-b border-[var(--border-raw)]/45",
                            )}
                          >
                            {isFirstEvent ? (
                              <td
                                rowSpan={r.events.length}
                                className={cn(
                                  "px-5 py-4 align-top text-[13px] font-medium whitespace-nowrap",
                                  isNegativeBalance
                                    ? "text-[var(--red)]"
                                    : isPayday
                                      ? "text-[var(--phosphor)]"
                                      : "text-[var(--text-1)]",
                                )}
                              >
                                {isNegativeBalance ? <NegativeBalanceMarker /> : null}
                                <DateLabel iso={r.date} format="short" />
                              </td>
                            ) : null}
                            <td
                              className={cn(
                                "px-5 py-3",
                                isNegativeBalance
                                  ? "font-medium text-[var(--red)]"
                                  : isPayday
                                    ? "font-medium text-[var(--text-0)]"
                                    : "text-[var(--text-1)]",
                              )}
                            >
                              <div className="flex min-w-[18rem] items-center gap-3">
                                <EventAvatar event={event} isIncomeEvent={isIncomeEvent} />
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    {isNegativeBalance && isFirstEvent ? (
                                      <SoftPill tone="danger">Negative</SoftPill>
                                    ) : null}
                                    {isRefundEvent ? (
                                      <SoftPill tone="income">Refund</SoftPill>
                                    ) : isIncomeEvent ? (
                                      <SoftPill tone="income">Income</SoftPill>
                                    ) : null}
                                  </div>
                                  <ProjectionEventItem
                                    row={r}
                                    event={event}
                                    eventIndex={eventIndex}
                                    promoSummariesByCard={promoSummariesByCard}
                                    variableBillCategories={variableBillCategories}
                                    onAdjustPayment={setAdjustingPayment}
                                  />
                                </div>
                              </div>
                            </td>
                            <td className="px-5 py-3 text-right">
                              {isIncomeEvent ? (
                                <span className="font-semibold text-[var(--phosphor)]">
                                  +<Money cents={eventAbsCents} />
                                </span>
                              ) : (
                                <span className="text-[var(--text-3)]">—</span>
                              )}
                            </td>
                            <td className="px-5 py-3 text-right">
                              {event.isPaid ? (
                                <span className="font-semibold text-[var(--phosphor)]">
                                  Paid <Money cents={event.originalAmountCents ?? 0} />
                                </span>
                              ) : isExpenseEvent ? (
                                <span className="font-semibold text-[var(--red)]">
                                  −<Money cents={eventAbsCents} />
                                </span>
                              ) : (
                                <span className="text-[var(--text-3)]">—</span>
                              )}
                            </td>
                            {isFirstEvent ? (
                              <td
                                rowSpan={r.events.length}
                                className={cn(
                                  "px-5 py-4 text-right align-top text-[14px] font-semibold",
                                  balanceClass(r.balanceCents),
                                )}
                              >
                                <Money cents={r.balanceCents} />
                              </td>
                            ) : null}
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {adjustingPayment ? (
        <PaymentAdjustmentDialog
          adjustment={adjustingPayment}
          saving={savingAdjustment}
          onClose={() => setAdjustingPayment(null)}
          onSave={savePaymentAdjustment}
          onReset={resetPaymentAdjustment}
        />
      ) : null}
    </div>
  );
}

function LedgerMetric({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  detail: React.ReactNode;
  tone: "good" | "warn" | "danger";
}) {
  const toneClass =
    tone === "danger"
      ? "text-[var(--red)]"
      : tone === "warn"
        ? "text-[var(--amber)]"
        : "text-[var(--mint)]";

  return (
    <div className="min-h-[8.5rem] bg-[var(--bg-card)] p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="text-[13px] font-medium text-[var(--text-3)]">{label}</div>
        <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-[var(--bg-2)] text-[var(--text-2)]">
          <Icon className="h-4 w-4" strokeWidth={2} />
        </span>
      </div>
      <div
        className={cn("tabular text-[24px] leading-none font-semibold tracking-tight", toneClass)}
      >
        {value}
      </div>
      <div className="mt-3 text-[13px] text-[var(--text-2)]">{detail}</div>
    </div>
  );
}

function SoftPill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: SoftPillTone;
}) {
  const classes: Record<SoftPillTone, string> = {
    neutral: "bg-[color-mix(in_oklch,var(--text-2)_10%,transparent)] text-[var(--text-2)]",
    income: "bg-[color-mix(in_oklch,var(--phosphor)_12%,transparent)] text-[var(--phosphor)]",
    danger: "bg-[var(--red-glow)] text-[var(--red)]",
    warning: "bg-[color-mix(in_oklch,var(--amber)_12%,transparent)] text-[var(--amber)]",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-[12px] leading-none font-medium",
        classes[tone],
      )}
    >
      {children}
    </span>
  );
}

function EventAvatar({ event, isIncomeEvent }: { event: ProjectionEvent; isIncomeEvent: boolean }) {
  const isCard = event.sourceType === "creditCardPayment";
  const Icon = isIncomeEvent ? ArrowDownLeft : isCard ? CreditCard : ReceiptText;
  const toneClass = isIncomeEvent
    ? "bg-[color-mix(in_oklch,var(--phosphor)_12%,transparent)] text-[var(--phosphor)]"
    : isCard
      ? "bg-[color-mix(in_oklch,var(--cyan)_12%,transparent)] text-[var(--cyan)]"
      : "bg-[color-mix(in_oklch,var(--amber)_12%,transparent)] text-[var(--amber)]";

  return (
    <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-[12px]", toneClass)}>
      <Icon className="h-4.5 w-4.5" strokeWidth={2} />
    </span>
  );
}

function NegativeBalanceMarker() {
  return (
    <span
      className="group relative mr-1 inline-flex cursor-help items-center"
      aria-label={NEGATIVE_BALANCE_TOOLTIP}
      tabIndex={0}
    >
      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="pointer-events-none absolute top-5 left-0 z-20 hidden w-72 rounded-[12px] border border-[color-mix(in_oklch,var(--red)_30%,transparent)] bg-[var(--bg-card)] px-3 py-2 text-left text-[12px] leading-snug font-medium whitespace-normal text-[var(--text-1)] shadow-[0_8px_24px_rgba(0,0,0,0.18)] group-hover:block group-focus:block">
        {NEGATIVE_BALANCE_TOOLTIP}
      </span>
    </span>
  );
}

function ProjectionEventItem({
  row,
  event,
  eventIndex,
  promoSummariesByCard,
  variableBillCategories = {},
  onAdjustPayment,
}: {
  row: ProjectionRow;
  event: ProjectionEvent;
  eventIndex: number;
  promoSummariesByCard: Record<string, PromoPaymentSummary[]>;
  variableBillCategories?: Record<string, string[]>;
  onAdjustPayment: (adjustment: PaymentAdjustment) => void;
}) {
  const targetType =
    event.kind === "bill" && event.sourceType === "bill"
      ? "bill"
      : event.kind === "extra" && event.sourceType === "creditCardPayment"
        ? "creditCardPayment"
        : null;
  if (!targetType || !event.sourceId || event.originalAmountCents == null) {
    return (
      <div key={`${event.kind}-${event.label}-${eventIndex}`} className="min-w-0">
        <div className="truncate text-[14px] font-medium text-[var(--text-0)]">{event.label}</div>
        <div className="mt-0.5 text-[12px] text-[var(--text-3)]">
          {event.kind === "paycheck" ? "Paycheck" : event.kind === "bill" ? "Bill" : "One-time"}
        </div>
      </div>
    );
  }

  if (event.isPaid) {
    return (
      <div key={`${event.sourceId}-${row.date}-${eventIndex}`} className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <SoftPill tone="income">Paid</SoftPill>
          <span className="truncate text-[14px] font-medium text-[var(--text-0)]">
            {event.label}
          </span>
        </div>
        <span className="mt-0.5 block text-[12px] text-[var(--text-3)]">Reconciled payment</span>
      </div>
    );
  }

  const adjusted = event.amountCents !== event.originalAmountCents;
  const isPromoPayment =
    targetType === "creditCardPayment" && event.label.toLowerCase().includes("promo");
  const baseLabel = targetType === "bill" ? "Bill" : isPromoPayment ? "Promo" : "Card estimate";
  const paymentDueCents = event.paymentDueCents ?? event.originalAmountCents;
  const paymentBalanceCents = event.paymentBalanceCents;
  return (
    <div key={`${event.sourceId}-${row.date}-${eventIndex}`} className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <SoftPill tone={adjusted ? "warning" : "neutral"}>
          {adjusted ? "Planned" : baseLabel}
        </SoftPill>
        <button
          type="button"
          onClick={() =>
            onAdjustPayment({
              targetType,
              targetId: event.sourceId!,
              targetName: event.label,
              dueDate: row.date,
              relatedDate: event.relatedDate,
              amountCents: event.amountCents,
              originalAmountCents: event.originalAmountCents!,
              paymentDueCents,
              paymentBalanceCents,
              promoSummaries:
                targetType === "creditCardPayment"
                  ? (promoSummariesByCard[event.sourceId!] ?? [])
                  : [],
            })
          }
          className="min-w-0 truncate rounded-full px-1.5 py-1 text-left text-[14px] font-medium text-[var(--text-0)] transition-colors hover:bg-[var(--bg-2)]"
        >
          {event.label}
        </button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--text-3)]">
        {adjusted ? (
          <span>
            Normal <Money cents={event.originalAmountCents} />
          </span>
        ) : null}
        {targetType === "creditCardPayment" ? (
          <>
            <span>
              Due <Money cents={paymentDueCents} />
            </span>
            {paymentBalanceCents != null ? (
              <span>
                Balance <Money cents={paymentBalanceCents} />
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      {(() => {
        const catKey = event.sourceId ? `${event.sourceId}:${row.date}` : "";
        const cats = catKey ? variableBillCategories[catKey] : undefined;
        if (!cats || cats.length === 0) return null;
        return (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {cats.map((cat) => (
              <SoftPill key={cat}>{cat}</SoftPill>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

function PaymentAdjustmentDialog({
  adjustment,
  saving,
  onClose,
  onSave,
  onReset,
}: {
  adjustment: PaymentAdjustment;
  saving: boolean;
  onClose: () => void;
  onSave: (
    adjustment: PaymentAdjustment,
    amountCents: number,
    plannedDate: string,
  ) => Promise<void>;
  onReset: (adjustment: PaymentAdjustment) => Promise<void>;
}) {
  const [amountCents, setAmountCents] = React.useState(adjustment.amountCents);
  const [plannedDate, setPlannedDate] = React.useState(adjustment.dueDate);
  const adjusted = amountCents !== adjustment.originalAmountCents;
  const dateAdjusted = Boolean(adjustment.relatedDate) || plannedDate !== adjustment.dueDate;
  const hasPlan = adjusted || dateAdjusted;
  const baselineLabel = adjustment.targetType === "bill" ? "Normal bill" : "Amount due";
  const paymentDueCents = adjustment.paymentDueCents ?? adjustment.originalAmountCents;
  const paymentBalanceCents = adjustment.paymentBalanceCents;
  const exceedsBalance =
    adjustment.targetType === "creditCardPayment" &&
    paymentBalanceCents != null &&
    amountCents > paymentBalanceCents;
  const promoSummaries = adjustment.promoSummaries ?? [];
  const promoRemainingCents = promoSummaries.reduce(
    (total, promo) => total + promo.remainingAmountCents,
    0,
  );

  React.useEffect(() => {
    setAmountCents(adjustment.amountCents);
    setPlannedDate(adjustment.dueDate);
  }, [adjustment]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <CardSubTag>PAYMENT_PLAN</CardSubTag>
          <DialogTitle>{adjustment.targetName.toUpperCase()}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            void onSave(adjustment, amountCents, plannedDate);
          }}
        >
          <div className="grid gap-3 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] p-3 text-[10px] tracking-[0.14em] text-[var(--text-2)] uppercase">
            <div className="flex items-center justify-between gap-3">
              <span>
                {adjustment.targetType === "creditCardPayment" ? "Original cycle" : "Due date"}
              </span>
              <span className="text-[var(--text-0)]">
                <DateLabel iso={adjustment.relatedDate ?? adjustment.dueDate} format="short" />
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>{baselineLabel}</span>
              <span className="text-[var(--text-0)]">
                <Money cents={paymentDueCents} />
              </span>
            </div>
            {adjustment.targetType === "creditCardPayment" && paymentBalanceCents != null ? (
              <div className="flex items-center justify-between gap-3">
                <span>Current balance</span>
                <span className="text-[var(--text-0)]">
                  <Money cents={paymentBalanceCents} />
                </span>
              </div>
            ) : null}
          </div>

          {adjustment.targetType === "creditCardPayment" ? (
            <div className="space-y-1.5">
              <label
                htmlFor="planned-payment-date"
                className="text-[10px] tracking-[0.15em] text-[var(--text-2)] uppercase"
              >
                Planned payment date
              </label>
              <Input
                id="planned-payment-date"
                type="date"
                value={plannedDate}
                onChange={(event) => setPlannedDate(event.target.value)}
                disabled={saving}
              />
            </div>
          ) : null}

          <div className="space-y-1.5">
            <label
              htmlFor="planned-payment-cents"
              className="text-[10px] tracking-[0.15em] text-[var(--text-2)] uppercase"
            >
              Planned payment for this cycle
            </label>
            <MoneyInput
              id="planned-payment-cents"
              valueCents={amountCents}
              onChangeCents={setAmountCents}
              disabled={saving}
            />
            {exceedsBalance ? (
              <div className="text-[10px] tracking-[0.12em] text-[var(--red)] uppercase">
                Planned payment exceeds the displayed card balance.
              </div>
            ) : null}
            {adjustment.targetType === "creditCardPayment" ? (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setAmountCents(paymentDueCents)}
                  disabled={saving}
                >
                  PAY DUE
                </Button>
                {paymentBalanceCents != null ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setAmountCents(paymentBalanceCents)}
                    disabled={saving}
                  >
                    PAY BALANCE
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          {adjustment.targetType === "creditCardPayment" && promoSummaries.length > 0 ? (
            <div className="space-y-2 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] p-3">
              <div className="flex items-center justify-between gap-3 text-[10px] tracking-[0.15em] text-[var(--text-2)] uppercase">
                <span>Remaining promo balance</span>
                <span className="font-mono text-[var(--text-0)]">
                  <Money cents={promoRemainingCents} />
                </span>
              </div>
              <div className="divide-y divide-[var(--border-raw)]/60">
                {promoSummaries.map((promo) => (
                  <div
                    key={promo.id}
                    className="grid gap-2 py-2 text-[10px] tracking-[0.12em] text-[var(--text-2)] uppercase sm:grid-cols-[1fr_auto_auto]"
                  >
                    <span className="min-w-0 truncate text-[var(--text-0)]">
                      {promo.description}
                    </span>
                    <span>
                      <Money cents={promo.remainingAmountCents} />
                    </span>
                    <span>
                      BY <DateLabel iso={promo.endDate} format="short" />
                      {promo.monthlyPaymentCents != null ? (
                        <>
                          {" · "}
                          <Money cents={promo.monthlyPaymentCents} />
                          /MO
                        </>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <DialogFooter>
            {hasPlan ? (
              <Button
                type="button"
                variant="destructive"
                onClick={() => void onReset(adjustment)}
                disabled={saving}
              >
                RESET
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
                CANCEL
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={saving || amountCents < 0 || !plannedDate || exceedsBalance}
              >
                {saving ? "SAVING..." : "SAVE PLAN"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PaycheckSectionHeader({ section, index }: { section: LedgerSection; index: number }) {
  const remainingCents = section.sourceAmountCents - section.expenseCents;
  const title = section.isOpeningBalance ? "Opening balance buffer" : `Paycheck cycle ${index + 1}`;

  return (
    <tr className="border-y border-[var(--border-raw)] bg-[var(--bg-2)]">
      <td colSpan={5} className="px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[13px] font-medium text-[var(--text-3)]">{title}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[15px] font-semibold text-[var(--text-0)]">
              <span>{section.sourceLabel}</span>
              {section.sourceDate ? (
                <span className="text-[var(--phosphor)]">
                  <DateLabel iso={section.sourceDate} format="short" />
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!section.isOpeningBalance ? (
              <SoftPill tone="income">
                Source +<Money cents={section.sourceAmountCents} />
              </SoftPill>
            ) : null}
            <SoftPill
              tone={
                section.expenseCents > section.sourceAmountCents && !section.isOpeningBalance
                  ? "danger"
                  : "neutral"
              }
            >
              Pays <Money cents={section.expenseCents} />
            </SoftPill>
            <SoftPill tone={remainingCents < 0 && !section.isOpeningBalance ? "danger" : "neutral"}>
              {section.billCount} bill{section.billCount === 1 ? "" : "s"}
            </SoftPill>
          </div>
        </div>
      </td>
    </tr>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded-full border px-4 py-2 text-[13px] font-medium transition-colors",
        active
          ? "border-[var(--phosphor)] bg-[color-mix(in_oklch,var(--phosphor)_12%,transparent)] text-[var(--phosphor)]"
          : "border-[var(--border-raw)] bg-[var(--bg-2)] text-[var(--text-2)] hover:border-[var(--border-2)] hover:text-[var(--text-0)]",
      )}
    >
      {children}
    </button>
  );
}
