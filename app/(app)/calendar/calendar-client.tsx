"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CardSubTag } from "@/components/ui/page-head";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import { cn } from "@/lib/cn";
import { BillForm, type BillFormValues } from "../bills/bill-form";
import type { ProjectionEvent, ProjectionRow } from "@/lib/projection";

const MONTH_NAMES = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MAX_CHIPS_PER_DAY = 3;

type EventTone = "income" | "card" | "expense" | "settled";

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

function toneOf(ev: ProjectionEvent): EventTone {
  if (ev.isPaid && ev.amountCents === 0) return "settled";
  if (ev.kind === "paycheck") return "income";
  if (ev.kind === "extra" && ev.amountCents < 0) return "income";
  if (ev.sourceType === "creditCardPayment") return "card";
  return "expense";
}

const TONE_CLASSES: Record<EventTone, string> = {
  income: "border-[var(--mint-dim)] bg-[var(--mint-glow)] text-[var(--mint)]",
  card: "border-[var(--amber)]/40 bg-[var(--amber)]/10 text-[var(--amber)]",
  expense: "border-[var(--red)]/40 bg-[var(--red)]/10 text-[var(--red)]",
  settled: "border-[var(--border-raw)] bg-[var(--bg-2)] text-[var(--text-3)] line-through",
};

const TONE_TEXT: Record<EventTone, string> = {
  income: "text-[var(--mint)]",
  card: "text-[var(--amber)]",
  expense: "text-[var(--red)]",
  settled: "text-[var(--text-3)] line-through",
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
  const [categoriesState, setCategoriesState] = React.useState<string[]>(() => [...categories]);
  const [submitting, setSubmitting] = React.useState(false);

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
          ) — no scheduled events to show, but you can still click a day to add a bill.
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
                    {row && events.length > 0 ? (
                      <span className="tabular text-[10px] text-[var(--text-3)]">
                        <Money cents={row.balanceCents} />
                      </span>
                    ) : null}
                  </div>
                  <div className="space-y-1">
                    {events.slice(0, MAX_CHIPS_PER_DAY).map((ev, j) => {
                      const tone = toneOf(ev);
                      const credit = tone === "income";
                      return (
                        <div
                          key={`${iso}-${j}`}
                          className={cn(
                            "flex items-center justify-between gap-1 rounded-[2px] border px-1 py-0.5 text-[10px] leading-tight",
                            TONE_CLASSES[tone],
                          )}
                        >
                          <span className="truncate">{ev.label}</span>
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
        <span className={cn("rounded-[2px] border px-1.5 py-0.5", TONE_CLASSES.settled)}>SETTLED</span>
      </div>

      {/* day detail */}
      <Dialog open={selectedDate !== null && addBillFor === null} onOpenChange={(o) => !o && setSelectedDate(null)}>
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
                    const tone = toneOf(ev);
                    const credit = tone === "income";
                    return (
                      <div
                        key={i}
                        className="flex items-center justify-between gap-3 border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-[13px] text-[var(--text-0)]">{ev.label}</div>
                          <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">
                            {ev.isPaid ? "settled" : ev.kind}
                          </div>
                        </div>
                        <span className={cn("tabular text-[13px] font-semibold", TONE_TEXT[tone])}>
                          {credit ? "+" : "−"}
                          <Money
                            cents={Math.abs(
                              ev.amountCents !== 0 ? ev.amountCents : (ev.originalAmountCents ?? 0),
                            )}
                          />
                        </span>
                      </div>
                    );
                  })
                )}
                {selectedRow ? (
                  <div className="flex items-center justify-between border-t border-[var(--border-raw)] pt-2 text-[12px] text-[var(--text-2)]">
                    <span>END-OF-DAY BALANCE</span>
                    <span
                      className={cn(
                        "tabular font-semibold",
                        selectedRow.balanceCents >= 0 ? "text-[var(--mint)]" : "text-[var(--red)]",
                      )}
                    >
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
