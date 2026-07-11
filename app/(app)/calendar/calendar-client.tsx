"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronLeft, ChevronRight, CreditCard, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CardSubTag } from "@/components/ui/page-head";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/money";
import { MoneyInput } from "@/components/money-input";
import { DateLabel } from "@/components/date-label";
import { cn } from "@/lib/cn";
import { balanceToneClass, balanceSurfaceClass } from "@/lib/balance-tone";
import { BillForm, type BillFormValues } from "../bills/bill-form";
import type { ProjectionEvent, ProjectionRow } from "@/lib/projection";

const MONTH_NAMES = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MAX_CHIPS_PER_DAY = 3;

type EventTone = "income" | "card" | "expense" | "settled" | "posted";

type CardPaymentPlan = {
  cardId: string;
  label: string;
  dueDate: string;
  relatedDate?: string;
  amountCents: number;
  originalAmountCents: number;
  paymentDueCents: number;
  paymentBalanceCents?: number;
  dueLabel: string;
};

function cardPaymentDueLabel(label: string): string {
  const normalized = label.toLowerCase();
  if (normalized.includes("promo")) return "Deferred-interest payoff plan";
  if (normalized.includes("est")) return "Estimated amount due";
  if (normalized.includes("planned")) return "Planned card payment";
  return "Full statement to avoid interest";
}

function daysInMonth(year: number, month: number): number {
  // month is 1..12
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function firstWeekday(year: number, month: number): number {
  return new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
}

function isoOf(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isCredit(ev: ProjectionEvent): boolean {
  return ev.kind === "paycheck" || (ev.kind === "extra" && ev.amountCents < 0);
}

function toneOf(ev: ProjectionEvent, isPast: boolean): EventTone {
  if (ev.isPaid && ev.amountCents === 0) return "settled";
  // Events on days before today are history — posted transactions from the
  // lookback window, not upcoming obligations. Rendering them in the pending
  // red reads as "unpaid bill", which is exactly wrong.
  if (isPast) return "posted";
  if (isCredit(ev)) return "income";
  if (ev.sourceType === "creditCardPayment") return "card";
  return "expense";
}

const TONE_CLASSES: Record<EventTone, string> = {
  income: "border-[var(--mint-dim)] bg-[var(--mint-glow)] text-[var(--mint)]",
  card: "border-[var(--amber)]/40 bg-[var(--amber)]/10 text-[var(--amber)]",
  expense: "border-[var(--red)]/40 bg-[var(--red)]/10 text-[var(--red)]",
  settled: "border-[var(--border-raw)] bg-[var(--bg-2)] text-[var(--text-3)] line-through",
  posted: "border-[var(--border-raw)] bg-[var(--bg-2)] text-[var(--text-2)]",
};

const TONE_TEXT: Record<EventTone, string> = {
  income: "text-[var(--mint)]",
  card: "text-[var(--amber)]",
  expense: "text-[var(--red)]",
  settled: "text-[var(--text-3)] line-through",
  posted: "text-[var(--text-2)]",
};

export function CalendarClient({
  rows,
  today,
  startDate,
  endDate,
  categories,
  cards,
}: {
  rows: ProjectionRow[];
  today: string;
  startDate: string;
  endDate: string;
  categories: ReadonlyArray<string>;
  cards: ReadonlyArray<{ id: string; name: string; isActive: boolean }>;
}) {
  const router = useRouter();
  const [year, setYear] = React.useState(() => Number(today.slice(0, 4)));
  const [month, setMonth] = React.useState(() => Number(today.slice(5, 7)));
  const [selectedDate, setSelectedDate] = React.useState<string | null>(null);
  const [addBillFor, setAddBillFor] = React.useState<string | null>(null);
  const [planningCardPayment, setPlanningCardPayment] = React.useState<CardPaymentPlan | null>(null);
  const [categoriesState, setCategoriesState] = React.useState<string[]>(() => [...categories]);
  const [submitting, setSubmitting] = React.useState(false);
  const [savingCardPayment, setSavingCardPayment] = React.useState(false);

  const rowByDate = React.useMemo(() => {
    const map = new Map<string, ProjectionRow>();
    for (const row of rows) map.set(row.date, row);
    return map;
  }, [rows]);

  const moveMonth = (delta: number) => {
    const total = year * 12 + (month - 1) + delta;
    setYear(Math.floor(total / 12));
    setMonth(((total % 12) + 12) % 12 + 1);
  };
  const goToToday = () => {
    setYear(Number(today.slice(0, 4)));
    setMonth(Number(today.slice(5, 7)));
  };

  const dayCount = daysInMonth(year, month);
  const leadingBlanks = firstWeekday(year, month);
  const cells: Array<string | null> = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...Array.from({ length: dayCount }, (_, i) => isoOf(year, month, i + 1)),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const monthPrefix = `${year}-${String(month).padStart(2, "0")}`;
  const monthRows = rows.filter((r) => r.date.startsWith(monthPrefix));
  const monthIncome = monthRows.reduce((s, r) => s + r.incomeCents, 0);
  const monthExpense = monthRows.reduce((s, r) => s + r.expenseCents, 0);
  const outsideWindow = monthRows.length === 0;

  const selectedRow = selectedDate ? rowByDate.get(selectedDate) : undefined;

  const createBill = async (values: BillFormValues) => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/bills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "create failed");
      setAddBillFor(null);
      setSelectedDate(null);
      toast.success("Bill added");
      // Events come from the server projection bundle — refetch it.
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const putCardPaymentOverride = async (
    plan: CardPaymentPlan,
    dueDate: string,
    amountCents: number,
    notes?: string | null,
  ) => {
    const res = await fetch(`/api/credit-cards/${plan.cardId}/payment-overrides`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dueDate, amountCents, notes }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "save failed");
  };

  const deleteCardPaymentOverride = async (plan: CardPaymentPlan, dueDate: string) => {
    const qs = new URLSearchParams({ dueDate });
    const res = await fetch(
      `/api/credit-cards/${plan.cardId}/payment-overrides?${qs}`,
      { method: "DELETE" },
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "reset failed");
  };

  const saveCardPaymentPlan = async (
    plan: CardPaymentPlan,
    amountCents: number,
    plannedDate: string,
  ) => {
    setSavingCardPayment(true);
    try {
      const originalDate = plan.relatedDate ?? plan.dueDate;
      const moved = plannedDate !== originalDate;
      if (moved) {
        await putCardPaymentOverride(plan, originalDate, 0, `moved-to:${plannedDate}`);
        await putCardPaymentOverride(plan, plannedDate, amountCents, `moved-from:${originalDate}`);
        if (plan.dueDate !== originalDate && plan.dueDate !== plannedDate) {
          await deleteCardPaymentOverride(plan, plan.dueDate);
        }
      } else if (amountCents === plan.originalAmountCents) {
        await deleteCardPaymentOverride(plan, plan.dueDate);
        if (plan.relatedDate && plan.relatedDate !== plan.dueDate) {
          await deleteCardPaymentOverride(plan, plan.relatedDate);
        }
      } else {
        await putCardPaymentOverride(plan, plannedDate, amountCents, null);
        if (plan.dueDate !== plannedDate) {
          await deleteCardPaymentOverride(plan, plan.dueDate);
        }
      }
      toast.success("Card payment plan saved");
      setPlanningCardPayment(null);
      setSelectedDate(null);
      router.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSavingCardPayment(false);
    }
  };

  const resetCardPaymentPlan = async (plan: CardPaymentPlan) => {
    setSavingCardPayment(true);
    try {
      const dates = new Set(
        [plan.dueDate, plan.relatedDate].filter((date): date is string => Boolean(date)),
      );
      for (const date of dates) await deleteCardPaymentOverride(plan, date);
      toast.success("Card payment plan reset");
      setPlanningCardPayment(null);
      setSelectedDate(null);
      router.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSavingCardPayment(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => moveMonth(-1)} aria-label="Previous month">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={() => moveMonth(1)} aria-label="Next month">
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="outline" onClick={goToToday}>
            TODAY
          </Button>
          <div className="ml-2 text-[18px] font-bold tracking-[0.08em] text-[var(--text-0)]">
            {MONTH_NAMES[month - 1]} <span className="text-[var(--text-2)]">{year}</span>
          </div>
        </div>
        <div className="flex items-center gap-4 text-[12px]">
          <span className="text-[var(--text-3)]">
            IN <span className="tabular font-semibold text-[var(--mint)]"><Money cents={monthIncome} /></span>
          </span>
          <span className="text-[var(--text-3)]">
            OUT <span className="tabular font-semibold text-[var(--red)]"><Money cents={monthExpense} /></span>
          </span>
          <span className="text-[var(--text-3)]">
            NET{" "}
            <span
              className={cn(
                "tabular font-semibold",
                monthIncome - monthExpense >= 0 ? "text-[var(--mint)]" : "text-[var(--red)]",
              )}
            >
              <Money cents={monthIncome - monthExpense} />
            </span>
          </span>
        </div>
      </div>

      {outsideWindow ? (
        <p className="text-[12px] text-[var(--text-3)]">
          This month is outside the projection window (
          <DateLabel iso={startDate} format="short" /> – <DateLabel iso={endDate} format="short" />
          ) — no scheduled events to show, but you can still click a day to add a bill or plan a card payment.
        </p>
      ) : null}

      <Card className="overflow-x-auto p-0">
        <div className="min-w-[720px]">
          <div className="grid grid-cols-7 border-b border-[var(--border-raw)]">
            {WEEKDAYS.map((d) => (
              <div
                key={d}
                className="px-2 py-2 text-center text-[10px] font-semibold tracking-[0.2em] text-[var(--text-3)]"
              >
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((iso, i) => {
              if (!iso) {
                return <div key={`blank-${i}`} className="min-h-[104px] border-b border-r border-[var(--border-raw)] bg-[var(--bg-0)]" />;
              }
              const row = rowByDate.get(iso);
              const events = row?.events ?? [];
              const isToday = iso === today;
              const isPast = iso < today;
              const overflow = events.length - MAX_CHIPS_PER_DAY;
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => setSelectedDate(iso)}
                  className={cn(
                    "min-h-[104px] cursor-pointer border-b border-r border-[var(--border-raw)] p-1.5 text-left align-top transition-colors",
                    "hover:bg-[var(--bg-2)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--mint)]",
                    isToday ? "bg-[var(--mint-glow)]" : "bg-[var(--bg-1)]",
                    isPast && !isToday ? "opacity-60" : "",
                  )}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span
                      className={cn(
                        "tabular text-[11px] font-semibold",
                        isToday
                          ? "rounded-[2px] bg-[var(--mint)] px-1 text-[var(--bg-0)]"
                          : "text-[var(--text-2)]",
                      )}
                    >
                      {Number(iso.slice(8, 10))}
                    </span>
                    {row ? (
                      <span
                        className={cn(
                          "tabular rounded-[2px] px-1 text-[10px] font-semibold",
                          balanceToneClass(row.balanceCents),
                          balanceSurfaceClass(row.balanceCents),
                        )}
                        title="Balance left after this day"
                      >
                        <Money cents={row.balanceCents} />
                      </span>
                    ) : null}
                  </div>
                  <div className="space-y-1">
                    {events.slice(0, MAX_CHIPS_PER_DAY).map((ev, j) => {
                      const tone = toneOf(ev, isPast);
                      const credit = isCredit(ev);
                      const cardDue =
                        ev.sourceType === "creditCardPayment" && (ev.paymentDueCents ?? 0) > 0;
                      return (
                        <div
                          key={`${iso}-${j}`}
                          className={cn(
                            "flex items-center justify-between gap-1 rounded-[2px] border px-1 py-0.5 text-[10px] leading-tight",
                            TONE_CLASSES[tone],
                          )}
                        >
                          <span className="min-w-0 truncate">
                            {cardDue ? `CARD DUE · ${ev.label}` : ev.label}
                          </span>
                          <span className="tabular shrink-0">
                            {credit ? "+" : "−"}
                            <Money
                              cents={Math.abs(
                                ev.amountCents !== 0 ? ev.amountCents : (ev.originalAmountCents ?? 0),
                              )}
                            />
                          </span>
                        </div>
                      );
                    })}
                    {overflow > 0 ? (
                      <div className="text-[10px] text-[var(--text-3)]">+{overflow} MORE</div>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3 text-[10px] tracking-[0.12em] text-[var(--text-3)]">
        <span className={cn("rounded-[2px] border px-1.5 py-0.5", TONE_CLASSES.income)}>PAYCHECK / CREDIT</span>
        <span className={cn("rounded-[2px] border px-1.5 py-0.5", TONE_CLASSES.expense)}>BILL / EXPENSE</span>
        <span className={cn("rounded-[2px] border px-1.5 py-0.5", TONE_CLASSES.card)}>CARD PAYMENT</span>
        <span className={cn("rounded-[2px] border px-1.5 py-0.5", TONE_CLASSES.settled)}>PAID / SETTLED</span>
        <span className={cn("rounded-[2px] border px-1.5 py-0.5", TONE_CLASSES.posted)}>POSTED (HISTORY)</span>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[10px] tracking-[0.12em] text-[var(--text-3)]">
        <span className="text-[var(--text-2)]">BALANCE LEFT AFTER DAY:</span>
        <span className={cn("tabular rounded-[2px] px-1.5 py-0.5", balanceToneClass(1_000_00), balanceSurfaceClass(1_000_00))}>
          COMFORTABLE
        </span>
        <span className={cn("tabular rounded-[2px] px-1.5 py-0.5", balanceToneClass(100_00), balanceSurfaceClass(100_00))}>
          LOW (&lt; $500)
        </span>
        <span className={cn("tabular rounded-[2px] px-1.5 py-0.5", balanceToneClass(-1), balanceSurfaceClass(-1))}>
          NEGATIVE
        </span>
      </div>

      {/* day detail */}
      <Dialog
        open={selectedDate !== null && addBillFor === null && planningCardPayment === null}
        onOpenChange={(o) => !o && setSelectedDate(null)}
      >
        <DialogContent>
          {selectedDate ? (
            <>
              <DialogHeader>
                <CardSubTag>DAY_DETAIL</CardSubTag>
                <DialogTitle>
                  <DateLabel iso={selectedDate} format="long" />
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-2">
                {(selectedRow?.events ?? []).length === 0 ? (
                  <p className="text-[13px] text-[var(--text-2)]">No scheduled events on this day.</p>
                ) : (
                  (selectedRow?.events ?? []).map((ev, i) => {
                    const isPastDay = selectedDate < today;
                    const tone = toneOf(ev, isPastDay);
                    const credit = isCredit(ev);
                    const isCardPayment =
                      ev.sourceType === "creditCardPayment" && Boolean(ev.sourceId);
                    const paymentDueCents =
                      ev.paymentDueCents ?? ev.originalAmountCents ?? ev.amountCents;
                    const originalDueDate = ev.relatedDate ?? selectedDate;
                    const dueLabel = cardPaymentDueLabel(ev.label);
                    return (
                      <div
                        key={i}
                        className="flex flex-wrap items-center justify-between gap-3 border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="break-words text-[13px] text-[var(--text-0)]">{ev.label}</div>
                          <div
                            className={cn(
                              "text-[10px] uppercase tracking-[0.12em]",
                              ev.isPaid ? "font-semibold text-[var(--mint)]" : "text-[var(--text-3)]",
                            )}
                          >
                            {ev.isPaid
                              ? "paid"
                              : isPastDay
                                ? "posted"
                                : isCardPayment
                                  ? paymentDueCents > 0
                                    ? "card due"
                                    : "card plan"
                                  : ev.kind}
                          </div>
                          {isCardPayment && paymentDueCents > 0 ? (
                            <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-[var(--amber)]">
                              {dueLabel} · due <DateLabel iso={originalDueDate} format="short" /> ·{" "}
                              <Money cents={paymentDueCents} />
                            </div>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={cn("tabular text-[13px] font-semibold", TONE_TEXT[tone])}>
                            {credit ? "+" : "−"}
                            <Money
                              cents={Math.abs(
                                ev.amountCents !== 0 ? ev.amountCents : (ev.originalAmountCents ?? 0),
                              )}
                            />
                          </span>
                          {isCardPayment && !ev.isPaid && !isPastDay ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setPlanningCardPayment({
                                  cardId: ev.sourceId!,
                                  label: ev.label,
                                  dueDate: selectedDate,
                                  relatedDate: ev.relatedDate,
                                  amountCents: ev.amountCents,
                                  originalAmountCents:
                                    ev.originalAmountCents ?? paymentDueCents,
                                  paymentDueCents,
                                  paymentBalanceCents: ev.paymentBalanceCents,
                                  dueLabel,
                                })
                              }
                            >
                              <CreditCard className="mr-1 h-3.5 w-3.5" /> PROGRAM PAYMENT
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                )}
                {selectedRow ? (
                  <div className="flex items-center justify-between border-t border-[var(--border-raw)] pt-2 text-[12px] text-[var(--text-2)]">
                    <span>END-OF-DAY BALANCE</span>
                    <span className={cn("tabular font-semibold", balanceToneClass(selectedRow.balanceCents))}>
                      <Money cents={selectedRow.balanceCents} />
                    </span>
                  </div>
                ) : null}
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setSelectedDate(null)}>
                  CLOSE
                </Button>
                <Button variant="primary" onClick={() => setAddBillFor(selectedDate)}>
                  <Plus className="mr-1 h-4 w-4" /> ADD BILL
                </Button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {planningCardPayment ? (
        <CardPaymentPlanDialog
          plan={planningCardPayment}
          today={today}
          saving={savingCardPayment}
          onClose={() => setPlanningCardPayment(null)}
          onSave={saveCardPaymentPlan}
          onReset={resetCardPaymentPlan}
        />
      ) : null}

      {/* add bill on the clicked day */}
      <Dialog open={addBillFor !== null} onOpenChange={(o) => !o && setAddBillFor(null)}>
        <DialogContent>
          {addBillFor ? (
            <>
              <DialogHeader>
                <CardSubTag>NEW_BILL</CardSubTag>
                <DialogTitle>
                  ADD BILL — <DateLabel iso={addBillFor} format="short" />
                </DialogTitle>
              </DialogHeader>
              <BillForm
                categories={categoriesState}
                cards={cards}
                defaultAnchorDate={addBillFor}
                onCategoryAdded={(c) => setCategoriesState((prev) => [...prev, c])}
                onSubmit={createBill}
                onCancel={() => setAddBillFor(null)}
                submitting={submitting}
              />
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CardPaymentPlanDialog({
  plan,
  today,
  saving,
  onClose,
  onSave,
  onReset,
}: {
  plan: CardPaymentPlan;
  today: string;
  saving: boolean;
  onClose: () => void;
  onSave: (plan: CardPaymentPlan, amountCents: number, plannedDate: string) => Promise<void>;
  onReset: (plan: CardPaymentPlan) => Promise<void>;
}) {
  const [amountCents, setAmountCents] = React.useState(plan.amountCents);
  const [plannedDate, setPlannedDate] = React.useState(plan.dueDate);
  const originalDueDate = plan.relatedDate ?? plan.dueDate;
  const shortfallCents = Math.max(0, plan.paymentDueCents - amountCents);
  const afterDueDate = plannedDate > originalDueDate;
  const beforeToday = plannedDate < today;
  const exceedsBalance =
    plan.paymentBalanceCents != null && amountCents > plan.paymentBalanceCents;
  const hasPlan =
    plan.relatedDate != null ||
    plan.dueDate !== originalDueDate ||
    plan.amountCents !== plan.originalAmountCents;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <CardSubTag>CARD_PAYMENT_PLAN</CardSubTag>
          <DialogTitle>{plan.label.toUpperCase()}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            void onSave(plan, amountCents, plannedDate);
          }}
        >
          <div className="grid gap-3 border border-[var(--border-raw)] bg-[var(--bg-2)] p-3 text-[10px] uppercase tracking-[0.14em] text-[var(--text-2)]">
            <div className="flex items-center justify-between gap-3">
              <span>Card due date</span>
              <span className="text-[var(--amber)]">
                <DateLabel iso={originalDueDate} format="short" />
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>{plan.dueLabel}</span>
              <span className="font-bold tabular text-[var(--text-0)]">
                <Money cents={plan.paymentDueCents} />
              </span>
            </div>
            {plan.paymentBalanceCents != null ? (
              <div className="flex items-center justify-between gap-3">
                <span>Displayed card balance</span>
                <span className="tabular text-[var(--text-0)]">
                  <Money cents={plan.paymentBalanceCents} />
                </span>
              </div>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="calendar-card-payment-date">PROGRAMMED PAYMENT DATE</Label>
            <Input
              id="calendar-card-payment-date"
              type="date"
              min={today}
              max={originalDueDate}
              value={plannedDate}
              onChange={(event) => setPlannedDate(event.target.value)}
              disabled={saving}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="calendar-card-payment-amount">PROGRAMMED PAYMENT AMOUNT</Label>
            <MoneyInput
              id="calendar-card-payment-amount"
              valueCents={amountCents}
              onChangeCents={setAmountCents}
              disabled={saving}
            />
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setAmountCents(plan.paymentDueCents)}
                disabled={saving}
              >
                PAY AMOUNT DUE
              </Button>
              {plan.paymentBalanceCents != null ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setAmountCents(plan.paymentBalanceCents!)}
                  disabled={saving}
                >
                  PAY CARD BALANCE
                </Button>
              ) : null}
            </div>
          </div>

          {shortfallCents > 0 ? (
            <div className="flex gap-2 border border-[var(--red)]/50 bg-[var(--red)]/10 p-3 text-[11px] text-[var(--red)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                This plan is short <Money cents={shortfallCents} /> of the full statement amount
                needed to avoid interest.
              </span>
            </div>
          ) : null}
          {afterDueDate || beforeToday ? (
            <div className="flex gap-2 border border-[var(--red)]/50 bg-[var(--red)]/10 p-3 text-[11px] text-[var(--red)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Choose a future date on or before the card due date.</span>
            </div>
          ) : null}
          {exceedsBalance ? (
            <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--red)]">
              Programmed payment exceeds the displayed card balance.
            </div>
          ) : null}

          <p className="text-[11px] text-[var(--text-3)]">
            This updates the Finance_OS cash-flow plan. It does not submit a payment to PayPal or
            the card issuer.
          </p>

          <DialogFooter>
            {hasPlan ? (
              <Button
                type="button"
                variant="destructive"
                onClick={() => void onReset(plan)}
                disabled={saving}
              >
                RESET PLAN
              </Button>
            ) : (
              <span />
            )}
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              CANCEL
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                saving ||
                amountCents <= 0 ||
                !plannedDate ||
                afterDueDate ||
                beforeToday ||
                exceedsBalance
              }
            >
              {saving ? "SAVING…" : "SAVE PAYMENT PLAN"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
