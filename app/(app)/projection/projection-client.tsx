"use client";

import * as React from "react";
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
import { StatusPill } from "@/components/ui/status-pill";
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
  { key: "MONTH", label: "THIS MONTH" },
  { key: "3M", label: "3 MONTHS" },
  { key: "6M", label: "6 MONTHS" },
  { key: "1Y", label: "1 YEAR" },
  { key: "ALL", label: "ALL" },
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
  return "text-[var(--mint)]";
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
        [adjustment.dueDate, adjustment.relatedDate].filter(
          (date): date is string => Boolean(date),
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Tab key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}
          </Tab>
        ))}
        <span className="mx-1 h-4 w-px bg-[var(--border-raw)]" aria-hidden />
        <Tab active={cardsOnly} onClick={() => setCardsOnly((v) => !v)}>
          CARDS + PROMOS
        </Tab>
        <div className="ml-auto text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]">
          <DateLabel iso={range.start} format="short" /> -{" "}
          <DateLabel iso={range.end} format="short" />
          {" · "}
          {windowRows.length} DAY{windowRows.length === 1 ? "" : "S"}
        </div>
      </div>

      <div className="max-h-[76vh] overflow-auto border border-[var(--border-raw)]">
          <table className="w-full text-[11px] font-mono tabular">
            <thead className="sticky top-0 z-10 bg-[var(--bg-1)] shadow-[0_1px_0_var(--border-raw)]">
              <tr className="border-b border-[var(--border-raw)]">
                {["DATE", "DESCRIPTION", "INCOME", "EXPENSE", "BALANCE"].map((h, i) => (
                  <th
                    key={h}
                    className={cn(
                      "px-4 py-3 text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-3)]",
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
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center text-[10px] uppercase tracking-[0.2em] text-[var(--text-3)]"
                  >
                    {cardsOnly
                      ? "No credit-card or promo payments in this window"
                      : "No income or expense events in this window"}
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
                      "transition-colors hover:bg-[var(--cyan-tint-hover)]",
                      "border-l-2",
                      section.isOpeningBalance ? "border-l-[var(--amber)]" : "border-l-[var(--mint-dim)]",
                      isNegativeBalance
                        ? "bg-[var(--red-glow)] border-l-[var(--red)]"
                        : isPayday
                          ? "bg-[var(--phosphor-tint-row)]"
                          : "bg-[var(--cyan-tint-zebra)]",
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
                          const isRefundEvent =
                            event.kind === "extra" && event.amountCents < 0;
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
                                    "whitespace-nowrap px-4 py-3 align-top font-semibold uppercase tracking-tight",
                                    isNegativeBalance
                                      ? "text-[var(--red)]"
                                      : isPayday
                                        ? "text-[var(--mint)]"
                                        : "text-[var(--text-1)]",
                                  )}
                                >
                                  {isNegativeBalance ? <NegativeBalanceMarker /> : null}
                                  <DateLabel iso={r.date} format="short" />
                                </td>
                              ) : null}
                              <td
                                className={cn(
                                  "px-4 py-2.5",
                                  isNegativeBalance
                                    ? "text-[var(--red)] font-semibold"
                                    : isPayday
                                      ? "text-[var(--mint)] font-semibold"
                                      : "text-[var(--text-1)]",
                                )}
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  {isNegativeBalance && isFirstEvent ? (
                                    <StatusPill variant="danger">NEGATIVE</StatusPill>
                                  ) : null}
                                  {isRefundEvent ? (
                                    <StatusPill>REFUND</StatusPill>
                                  ) : isIncomeEvent ? (
                                    <StatusPill>PAYCHECK SOURCE</StatusPill>
                                  ) : null}
                                  <ProjectionEventItem
                                    row={r}
                                    event={event}
                                    eventIndex={eventIndex}
                                    promoSummariesByCard={promoSummariesByCard}
                                    variableBillCategories={variableBillCategories}
                                    onAdjustPayment={setAdjustingPayment}
                                  />
                                </div>
                              </td>
                              <td className="px-4 py-2.5 text-right">
                                {isIncomeEvent ? (
                                  <span className="text-[var(--mint)] font-semibold">
                                    +<Money cents={eventAbsCents} />
                                  </span>
                                ) : (
                                  <span className="text-[var(--text-3)]">—</span>
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-right">
                                {event.isPaid ? (
                                  <span className="text-[var(--mint)] font-semibold">
                                    PAID <Money cents={event.originalAmountCents ?? 0} />
                                  </span>
                                ) : isExpenseEvent ? (
                                  <span className="text-[var(--red)] font-semibold">
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
                                    "px-4 py-3 align-top text-right font-bold",
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

function NegativeBalanceMarker() {
  return (
    <span
      className="group relative mr-1 inline-flex cursor-help items-center"
      aria-label={NEGATIVE_BALANCE_TOOLTIP}
      tabIndex={0}
    >
      <span aria-hidden="true">⚠</span>
      <span className="pointer-events-none absolute left-0 top-5 z-20 hidden w-72 whitespace-normal rounded-sm border border-[rgba(239,68,68,0.45)] bg-[var(--bg-1)] px-3 py-2 text-left text-[10px] font-medium uppercase leading-snug tracking-[0.12em] text-[var(--text-1)] shadow-[0_8px_24px_rgba(0,0,0,0.45)] group-hover:block group-focus:block">
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
    return <span key={`${event.kind}-${event.label}-${eventIndex}`}>{event.label}</span>;
  }

  if (event.isPaid) {
    return (
      <span
        key={`${event.sourceId}-${row.date}-${eventIndex}`}
        className="inline-flex flex-wrap items-center gap-1.5"
      >
        <StatusPill>PAID</StatusPill>
        <span className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--text-1)]">
          {event.label}
        </span>
      </span>
    );
  }

  const adjusted = event.amountCents !== event.originalAmountCents;
  const isPromoPayment =
    targetType === "creditCardPayment" && event.label.toLowerCase().includes("promo");
  const baseLabel = targetType === "bill" ? "BILL" : isPromoPayment ? "PROMO" : "CARD EST";
  const paymentDueCents = event.paymentDueCents ?? event.originalAmountCents;
  const paymentBalanceCents = event.paymentBalanceCents;
  return (
    <span
      key={`${event.sourceId}-${row.date}-${eventIndex}`}
      className="inline-flex flex-wrap items-center gap-1.5"
    >
      <StatusPill variant={adjusted ? "amber" : "off"}>
        {adjusted ? "PLANNED" : baseLabel}
      </StatusPill>
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
        className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--text-1)] hover:border-[var(--mint-dim)] hover:text-[var(--text-0)]"
      >
        {event.label}
      </button>
      {adjusted ? (
        <span className="text-[9px] uppercase tracking-[0.12em] text-[var(--text-3)]">
          BASE <Money cents={event.originalAmountCents} />
        </span>
      ) : null}
      {targetType === "creditCardPayment" ? (
        <span className="inline-flex flex-wrap items-center gap-1 text-[9px] uppercase tracking-[0.12em] text-[var(--text-3)]">
          <span>
            DUE <Money cents={paymentDueCents} />
          </span>
          {paymentBalanceCents != null ? (
            <span>
              BAL <Money cents={paymentBalanceCents} />
            </span>
          ) : null}
        </span>
      ) : null}
      {(() => {
        const catKey = event.sourceId ? `${event.sourceId}:${row.date}` : "";
        const cats = catKey ? variableBillCategories[catKey] : undefined;
        if (!cats || cats.length === 0) return null;
        return cats.map((cat) => (
          <span
            key={cat}
            className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-1)] px-1.5 py-0.5 text-[8px] uppercase tracking-[0.12em] text-[var(--text-2)]"
          >
            {cat}
          </span>
        ));
      })()}
    </span>
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
          <div className="grid gap-3 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] p-3 text-[10px] uppercase tracking-[0.14em] text-[var(--text-2)]">
            <div className="flex items-center justify-between gap-3">
              <span>{adjustment.targetType === "creditCardPayment" ? "Original cycle" : "Due date"}</span>
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
                className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]"
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
              className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]"
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
              <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--red)]">
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
              <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]">
                <span>Remaining promo balance</span>
                <span className="font-mono text-[var(--text-0)]">
                  <Money cents={promoRemainingCents} />
                </span>
              </div>
              <div className="divide-y divide-[var(--border-raw)]/60">
                {promoSummaries.map((promo) => (
                  <div
                    key={promo.id}
                    className="grid gap-2 py-2 text-[10px] uppercase tracking-[0.12em] text-[var(--text-2)] sm:grid-cols-[1fr_auto_auto]"
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
                          <Money cents={promo.monthlyPaymentCents} />/MO
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

function PaycheckSectionHeader({
  section,
  index,
}: {
  section: LedgerSection;
  index: number;
}) {
  const remainingCents = section.sourceAmountCents - section.expenseCents;
  const title = section.isOpeningBalance ? "OPENING BALANCE BUFFER" : `PAYCHECK CYCLE ${index + 1}`;

  return (
    <tr className="border-y border-[var(--cyan-tint-edge-hi)] bg-[linear-gradient(90deg,var(--cyan-tint-row),var(--surface-veil-strong)_48%,var(--phosphor-tint))]">
      <td colSpan={5} className="px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[9px] uppercase tracking-[0.22em] text-[var(--text-3)]">
              {`// ${title}`}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] font-bold uppercase tracking-[0.12em] text-[var(--text-0)]">
              <span>{section.sourceLabel}</span>
              {section.sourceDate ? (
                <span className="text-[var(--mint)]">
                  <DateLabel iso={section.sourceDate} format="short" />
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!section.isOpeningBalance ? (
              <StatusPill>
                SOURCE +<Money cents={section.sourceAmountCents} />
              </StatusPill>
            ) : null}
            <StatusPill variant={section.expenseCents > section.sourceAmountCents && !section.isOpeningBalance ? "danger" : "off"}>
              PAYS <Money cents={section.expenseCents} />
            </StatusPill>
            <StatusPill variant={remainingCents < 0 && !section.isOpeningBalance ? "danger" : "off"}>
              {section.billCount} BILL{section.billCount === 1 ? "" : "S"}
            </StatusPill>
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
        "rounded-sm border px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] transition-colors cursor-pointer font-mono",
        active
          ? "bg-[var(--mint-glow)] text-[var(--mint)] border-[var(--mint-dim)]"
          : "bg-[var(--bg-2)] text-[var(--text-2)] border-[var(--border-raw)] hover:text-[var(--text-0)] hover:border-[var(--border-2)]",
      )}
    >
      {children}
    </button>
  );
}
