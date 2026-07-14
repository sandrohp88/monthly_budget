"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronLeft, ChevronRight, CreditCard, Plus, Trash2 } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Money } from "@/components/money";
import { MoneyInput } from "@/components/money-input";
import { DateLabel } from "@/components/date-label";
import { cn } from "@/lib/cn";
import { balanceToneClass, balanceSurfaceClass } from "@/lib/balance-tone";
import { BillForm, type BillFormValues } from "../bills/bill-form";
import { cardPaymentMoveError } from "@/lib/card-payments";
import type { ProjectionEvent, ProjectionRow } from "@/lib/projection";

const MONTH_NAMES = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MAX_CHIPS_PER_DAY = 3;

type EventTone = "income" | "card" | "expense" | "settled" | "posted" | "onCard";

/** Next projected payment slot for a card — what a scheduled paydown reduces. */
type NextCardPayment = {
  date: string;
  dueCents: number;
  balanceCents?: number;
  label: string;
};

type SchedulePaymentDraft = {
  /** Default payment date (the clicked day, or the row being edited). */
  date: string;
  cardId?: string;
  amountCents?: number;
  existing?: { cardId: string; date: string; targetDate?: string };
};

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

/** A card-payment chip being dragged to a new day (drag-to-reschedule). */
type DragPayment = {
  cardId: string;
  fromDate: string;
  /** Cash that debits on the payment's day (what the chip shows). */
  amountCents: number;
  /** Cash still due at this slot — drives move validation + plan rebuild. */
  paymentDueCents: number;
  paymentBalanceCents?: number;
  originalAmountCents: number;
  relatedDate?: string;
  paydownTargetDate?: string;
  isPaydown: boolean;
  label: string;
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

const DAY_MS = 86_400_000;

function utcOfIso(iso: string): number {
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

function isoFromUtc(ms: number): string {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

function addDaysIso(iso: string, days: number): string {
  return isoFromUtc(utcOfIso(iso) + days * DAY_MS);
}

function weekdayOfIso(iso: string): number {
  return new Date(utcOfIso(iso)).getUTCDay();
}

/** Inclusive range of calendar days from `startIso` to `endInclusiveIso`. */
function eachDayIso(startIso: string, endInclusiveIso: string): string[] {
  const out: string[] = [];
  const end = utcOfIso(endInclusiveIso);
  for (let t = utcOfIso(startIso); t <= end; t += DAY_MS) out.push(isoFromUtc(t));
  return out;
}

/** A single pay cycle: the days from one payday up to (not incl.) the next. */
type PaycheckCycle = { start: string; endInclusive: string; nextPay?: string };

function isCredit(ev: ProjectionEvent): boolean {
  return ev.kind === "paycheck" || (ev.kind === "extra" && ev.amountCents < 0);
}

function toneOf(ev: ProjectionEvent, isPast: boolean): EventTone {
  if (ev.isPaid && ev.amountCents === 0) return "settled";
  // Events on days before today are history — posted transactions from the
  // lookback window, not upcoming obligations. Rendering them in the pending
  // red reads as "unpaid bill", which is exactly wrong.
  if (isPast) return "posted";
  // Charged to a credit card: informational, no cash leaves checking that day.
  if (ev.chargedToCardName) return "onCard";
  if (isCredit(ev)) return "income";
  if (ev.sourceType === "creditCardPayment") return "card";
  return "expense";
}

/**
 * Cash shown on a chip / detail row. Card-payment events whose cash was moved
 * or paid down elsewhere carry amountCents 0 — fall back to what's still due
 * that day, not the original, so a fully-covered due date reads $0.
 */
function displayCents(ev: ProjectionEvent): number {
  if (ev.amountCents !== 0) return Math.abs(ev.amountCents);
  if (ev.sourceType === "creditCardPayment" && !ev.isPaid) return ev.paymentDueCents ?? 0;
  return Math.abs(ev.originalAmountCents ?? 0);
}

/** Snapshot the data a dragged card-payment chip needs to reschedule itself. */
function dragPaymentOf(ev: ProjectionEvent, iso: string): DragPayment {
  const paymentDueCents = ev.paymentDueCents ?? ev.originalAmountCents ?? Math.abs(ev.amountCents);
  return {
    cardId: ev.sourceId!,
    fromDate: iso,
    amountCents: displayCents(ev),
    paymentDueCents,
    paymentBalanceCents: ev.paymentBalanceCents,
    originalAmountCents: ev.originalAmountCents ?? paymentDueCents,
    relatedDate: ev.relatedDate,
    paydownTargetDate: ev.paydownTargetDate,
    isPaydown: Boolean(ev.paydownTargetDate),
    label: ev.label,
  };
}

const TONE_CLASSES: Record<EventTone, string> = {
  income: "border-[var(--mint-dim)] bg-[var(--mint-glow)] text-[var(--mint)]",
  card: "border-[var(--amber)]/40 bg-[var(--amber)]/10 text-[var(--amber)]",
  expense: "border-[var(--red)]/40 bg-[var(--red)]/10 text-[var(--red)]",
  settled: "border-[var(--border-raw)] bg-[var(--bg-2)] text-[var(--text-3)] line-through",
  posted: "border-[var(--border-raw)] bg-[var(--bg-2)] text-[var(--text-2)]",
  onCard: "border-[var(--olive)]/50 bg-[var(--olive)]/10 text-[var(--olive)]",
};

const TONE_TEXT: Record<EventTone, string> = {
  income: "text-[var(--mint)]",
  card: "text-[var(--amber)]",
  expense: "text-[var(--red)]",
  settled: "text-[var(--text-3)] line-through",
  posted: "text-[var(--text-2)]",
  onCard: "text-[var(--olive)]",
};

function WeekdayHeader() {
  return (
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
  );
}

function BlankCell({ minHeightClass }: { minHeightClass: string }) {
  return (
    <div
      className={cn(
        minHeightClass,
        "border-b border-r border-[var(--border-raw)] bg-[var(--bg-0)]",
      )}
    />
  );
}

/**
 * One day in a calendar grid — shared by the month and paycheck-cycle views.
 * `maxChips` caps the event chips (month view); `null` shows every event
 * (paycheck view, where the taller cells have room and hiding an obligation
 * behind "+N MORE" would defeat the point of the cycle breakdown).
 */
function DayCell({
  iso,
  row,
  today,
  maxChips,
  minHeightClass,
  onSelect,
  canDrag,
  onPaymentDragStart,
  onPaymentDragEnd,
  onDayDragOver,
  onDayDrop,
  dragActive = false,
  dragOverDate = null,
  dragOverValid = false,
}: {
  iso: string;
  row: ProjectionRow | undefined;
  today: string;
  maxChips: number | null;
  minHeightClass: string;
  onSelect: (iso: string) => void;
  /** Whether a given event on this day can be dragged to reschedule it. */
  canDrag?: (ev: ProjectionEvent, iso: string) => boolean;
  onPaymentDragStart?: (ev: ProjectionEvent, iso: string) => void;
  onPaymentDragEnd?: () => void;
  onDayDragOver?: (iso: string) => void;
  onDayDrop?: (iso: string) => void;
  /** A drag is in progress somewhere on the grid. */
  dragActive?: boolean;
  /** The day currently hovered during a drag (for the drop highlight). */
  dragOverDate?: string | null;
  /** Whether dropping on the hovered day is a valid move. */
  dragOverValid?: boolean;
}) {
  // Busy days collapse to `maxChips` chips + a "+N MORE" control. Expanding
  // reveals every chip so overflow payments are draggable too (otherwise the
  // only way to reschedule a hidden payment was the edit dialog).
  const [expanded, setExpanded] = React.useState(false);
  const events = row?.events ?? [];
  const isToday = iso === today;
  const isPast = iso < today;
  const capped = maxChips != null && !expanded;
  const shown = capped ? events.slice(0, maxChips) : events;
  const overflow = capped ? events.length - maxChips! : 0;
  const canCollapse = expanded && maxChips != null && events.length > maxChips;
  const isDropHover = dragActive && dragOverDate === iso;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        // A click on a child control (expand / collapse "+N MORE") must not also
        // open the day detail — those buttons manage their own inline state.
        if ((e.target as HTMLElement).closest("button")) return;
        onSelect(iso);
      }}
      onKeyDown={(e) => {
        // Only when the cell itself is focused — let child controls (expand /
        // collapse) handle their own keyboard activation.
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onSelect(iso);
        }
      }}
      onDragOver={
        dragActive
          ? (e) => {
              e.preventDefault();
              onDayDragOver?.(iso);
            }
          : undefined
      }
      onDrop={
        dragActive
          ? (e) => {
              e.preventDefault();
              onDayDrop?.(iso);
            }
          : undefined
      }
      className={cn(
        minHeightClass,
        "cursor-pointer border-b border-r border-[var(--border-raw)] p-1.5 text-left align-top transition-colors",
        "hover:bg-[var(--bg-2)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--mint)]",
        isToday ? "bg-[var(--mint-glow)]" : "bg-[var(--bg-1)]",
        isPast && !isToday ? "opacity-60" : "",
        isDropHover
          ? dragOverValid
            ? "outline outline-2 outline-[var(--mint)] outline-offset-[-2px]"
            : "outline outline-2 outline-[var(--red)] outline-offset-[-2px]"
          : "",
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
        {shown.map((ev, j) => {
          const tone = toneOf(ev, isPast);
          const credit = isCredit(ev);
          const onCard = Boolean(ev.chargedToCardName);
          const cardDue =
            ev.sourceType === "creditCardPayment" && (ev.paymentDueCents ?? 0) > 0;
          const draggable = Boolean(canDrag?.(ev, iso));
          return (
            <div
              key={`${iso}-${j}`}
              draggable={draggable || undefined}
              onDragStart={
                draggable
                  ? (e) => {
                      e.stopPropagation();
                      // Payload rides in React state; dataTransfer is set so the
                      // drag is recognized across browsers (Firefox needs it).
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", ev.sourceId ?? "card-payment");
                      onPaymentDragStart?.(ev, iso);
                    }
                  : undefined
              }
              onDragEnd={draggable ? () => onPaymentDragEnd?.() : undefined}
              className={cn(
                "flex items-center justify-between gap-1 rounded-[2px] border px-1 py-0.5 text-[10px] leading-tight",
                TONE_CLASSES[tone],
                draggable ? "cursor-grab active:cursor-grabbing" : "",
              )}
              title={
                draggable
                  ? "Drag to reschedule"
                  : onCard
                    ? `Charged to ${ev.chargedToCardName}`
                    : undefined
              }
            >
              <span className="min-w-0 truncate">
                {cardDue ? `CARD DUE · ${ev.label}` : ev.label}
              </span>
              <span className="tabular shrink-0">
                {onCard ? "" : credit ? "+" : "−"}
                <Money cents={displayCents(ev)} />
              </span>
            </div>
          );
        })}
        {overflow > 0 ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(true);
            }}
            className="w-full rounded-[2px] px-1 py-0.5 text-left text-[10px] text-[var(--text-3)] transition-colors hover:bg-[var(--bg-2)] hover:text-[var(--text-1)]"
            title="Show all — reveals hidden payments so they can be dragged"
          >
            +{overflow} MORE
          </button>
        ) : null}
        {canCollapse ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(false);
            }}
            className="w-full rounded-[2px] px-1 py-0.5 text-left text-[10px] text-[var(--text-3)] transition-colors hover:bg-[var(--bg-2)] hover:text-[var(--text-1)]"
          >
            SHOW LESS
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A labeled figure in the paycheck-cycle summary strip. */
function CycleSummaryTile({
  label,
  value,
  valueClass,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className="bg-[var(--bg-1)] px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-3)]">
        {label}
      </div>
      <div className={cn("tabular mt-1 text-[16px] font-semibold text-[var(--text-0)]", valueClass)}>
        {value}
      </div>
      {sub ? (
        <div className="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">
          {sub}
        </div>
      ) : null}
    </div>
  );
}

export function CalendarClient({
  rows,
  today,
  startDate,
  endDate,
  categories,
  cards,
  overrides,
}: {
  rows: ProjectionRow[];
  today: string;
  startDate: string;
  endDate: string;
  categories: ReadonlyArray<string>;
  cards: ReadonlyArray<{ id: string; name: string; isActive: boolean }>;
  /** Every credit-card payment override row (keyed by card + due date). Lets the
   *  calendar tell which events are user-scheduled — deletable and draggable. */
  overrides: ReadonlyArray<{ cardId: string; dueDate: string }>;
}) {
  const router = useRouter();
  const [view, setView] = React.useState<"month" | "paycheck">("month");
  const [year, setYear] = React.useState(() => Number(today.slice(0, 4)));
  const [month, setMonth] = React.useState(() => Number(today.slice(5, 7)));
  // null = follow the cycle that contains today; a number pins a chosen cycle.
  const [cycleIndex, setCycleIndex] = React.useState<number | null>(null);
  const [selectedDate, setSelectedDate] = React.useState<string | null>(null);
  const [addBillFor, setAddBillFor] = React.useState<string | null>(null);
  const [planningCardPayment, setPlanningCardPayment] = React.useState<CardPaymentPlan | null>(null);
  const [schedulingPayment, setSchedulingPayment] = React.useState<SchedulePaymentDraft | null>(null);
  const [categoriesState, setCategoriesState] = React.useState<string[]>(() => [...categories]);
  const [submitting, setSubmitting] = React.useState(false);
  const [savingCardPayment, setSavingCardPayment] = React.useState(false);
  const [dragging, setDragging] = React.useState<DragPayment | null>(null);
  const [dragOver, setDragOver] = React.useState<{ date: string; valid: boolean } | null>(null);

  const rowByDate = React.useMemo(() => {
    const map = new Map<string, ProjectionRow>();
    for (const row of rows) map.set(row.date, row);
    return map;
  }, [rows]);

  const activeCards = React.useMemo(() => cards.filter((c) => c.isActive), [cards]);

  // Set of `${cardId}:${dueDate}` that have a payment-override row. An event at
  // such a key was scheduled by the user, so it's deletable and (as a plain
  // planned override) draggable.
  const overrideKeys = React.useMemo(() => {
    const set = new Set<string>();
    for (const o of overrides) set.add(`${o.cardId}:${o.dueDate}`);
    return set;
  }, [overrides]);

  const isScheduledPayment = React.useCallback(
    (ev: ProjectionEvent, iso: string): boolean =>
      ev.sourceType === "creditCardPayment" &&
      Boolean(ev.sourceId) &&
      overrideKeys.has(`${ev.sourceId}:${iso}`),
    [overrideKeys],
  );

  // A future, unpaid card-payment chip the user can drag to another day.
  const canDragPayment = React.useCallback(
    (ev: ProjectionEvent, iso: string): boolean => {
      if (ev.sourceType !== "creditCardPayment" || !ev.sourceId) return false;
      if (ev.isPaid || ev.chargedToCardName || iso < today) return false;
      // A real due (has cash), a scheduled paydown, or a plain planned override.
      // A fully-covered $0 slot with no plan of its own is not draggable.
      return (
        (ev.paymentDueCents ?? 0) > 0 ||
        Boolean(ev.paydownTargetDate) ||
        overrideKeys.has(`${ev.sourceId}:${iso}`)
      );
    },
    [overrideKeys, today],
  );

  // The card's next projected payment on/after `fromDate` — the slot a
  // scheduled paydown reduces. Skips paid markers and other paydowns.
  const findNextCardPayment = React.useCallback(
    (cardId: string, fromDate: string): NextCardPayment | undefined => {
      const from = fromDate > today ? fromDate : today;
      for (const row of rows) {
        if (row.date < from) continue;
        for (const ev of row.events) {
          if (ev.sourceType !== "creditCardPayment" || ev.sourceId !== cardId) continue;
          if (ev.isPaid || ev.paydownTargetDate) continue;
          const dueCents = (ev.paymentDueCents ?? 0) > 0 ? ev.paymentDueCents! : ev.amountCents;
          if (dueCents <= 0) continue;
          return {
            date: row.date,
            dueCents,
            balanceCents: ev.paymentBalanceCents,
            label: ev.label,
          };
        }
      }
      return undefined;
    },
    [rows, today],
  );

  const moveMonth = (delta: number) => {
    const total = year * 12 + (month - 1) + delta;
    setYear(Math.floor(total / 12));
    setMonth(((total % 12) + 12) % 12 + 1);
  };
  const goToToday = () => {
    setYear(Number(today.slice(0, 4)));
    setMonth(Number(today.slice(5, 7)));
    setCycleIndex(null);
  };
  const moveCycle = (delta: number) => {
    setCycleIndex(
      Math.min(Math.max(activeCycleIndex + delta, 0), Math.max(cycles.length - 1, 0)),
    );
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

  // ---- Paycheck-cycle view -------------------------------------------------
  // Each payday opens a cycle that runs until the day before the next payday
  // (the last one runs to the end of the projection window). This is the lens
  // that answers "what bills and card payments come out of THIS paycheck?".
  const paydays = React.useMemo(
    () => rows.filter((r) => r.events.some((e) => e.kind === "paycheck")).map((r) => r.date),
    [rows],
  );
  const cycles = React.useMemo<PaycheckCycle[]>(
    () =>
      paydays.map((start, i) => {
        const nextPay = paydays[i + 1];
        return { start, endInclusive: nextPay ? addDaysIso(nextPay, -1) : endDate, nextPay };
      }),
    [paydays, endDate],
  );
  const defaultCycleIndex = React.useMemo(() => {
    const first = cycles[0];
    if (!first) return 0;
    const idx = cycles.findIndex((c) => today >= c.start && today <= c.endInclusive);
    if (idx >= 0) return idx;
    return today < first.start ? 0 : cycles.length - 1;
  }, [cycles, today]);
  const activeCycleIndex = Math.min(
    Math.max(cycleIndex ?? defaultCycleIndex, 0),
    Math.max(cycles.length - 1, 0),
  );
  const activeCycle: PaycheckCycle | undefined = cycles[activeCycleIndex];

  const cycleRows = React.useMemo(
    () =>
      activeCycle
        ? rows.filter((r) => r.date >= activeCycle.start && r.date <= activeCycle.endInclusive)
        : [],
    [rows, activeCycle],
  );
  const cycleIncome = cycleRows.reduce((s, r) => s + r.incomeCents, 0);
  const cycleExpense = cycleRows.reduce((s, r) => s + r.expenseCents, 0);
  const cycleCardOut = React.useMemo(() => {
    let sum = 0;
    for (const r of cycleRows)
      for (const ev of r.events)
        if (!ev.chargedToCardName && ev.sourceType === "creditCardPayment" && !ev.isPaid)
          sum += displayCents(ev);
    return sum;
  }, [cycleRows]);
  const cycleEndBalance = cycleRows.at(-1)?.balanceCents;
  const cycleLowBalance = cycleRows.length
    ? Math.min(...cycleRows.map((r) => r.balanceCents))
    : undefined;

  const cycleCells = React.useMemo<Array<string | null>>(() => {
    if (!activeCycle) return [];
    const days = eachDayIso(activeCycle.start, activeCycle.endInclusive);
    const arr: Array<string | null> = [
      ...Array.from({ length: weekdayOfIso(activeCycle.start) }, () => null),
      ...days,
    ];
    while (arr.length % 7 !== 0) arr.push(null);
    return arr;
  }, [activeCycle]);

  const sumIncome = view === "month" ? monthIncome : cycleIncome;
  const sumExpense = view === "month" ? monthExpense : cycleExpense;

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
    cardId: string,
    dueDate: string,
    amountCents: number,
    notes?: string | null,
  ) => {
    const res = await fetch(`/api/credit-cards/${cardId}/payment-overrides`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dueDate, amountCents, notes }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "save failed");
  };

  const deleteCardPaymentOverride = async (cardId: string, dueDate: string) => {
    const qs = new URLSearchParams({ dueDate });
    const res = await fetch(
      `/api/credit-cards/${cardId}/payment-overrides?${qs}`,
      { method: "DELETE" },
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? "reset failed");
  };

  const saveScheduledPayment = async (
    cardId: string,
    date: string,
    amountCents: number,
    targetDate: string | undefined,
    previous?: { cardId: string; date: string },
  ) => {
    setSavingCardPayment(true);
    try {
      if (previous && (previous.cardId !== cardId || previous.date !== date)) {
        await deleteCardPaymentOverride(previous.cardId, previous.date);
      }
      await putCardPaymentOverride(
        cardId,
        date,
        amountCents,
        targetDate ? `pays-down:${targetDate}` : null,
      );
      toast.success("Card payment scheduled");
      setSchedulingPayment(null);
      setSelectedDate(null);
      router.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSavingCardPayment(false);
    }
  };

  const removeScheduledPayment = async (cardId: string, date: string) => {
    setSavingCardPayment(true);
    try {
      await deleteCardPaymentOverride(cardId, date);
      toast.success("Scheduled payment removed");
      setSchedulingPayment(null);
      setSelectedDate(null);
      router.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSavingCardPayment(false);
    }
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
        await putCardPaymentOverride(plan.cardId, originalDate, 0, `moved-to:${plannedDate}`);
        await putCardPaymentOverride(plan.cardId, plannedDate, amountCents, `moved-from:${originalDate}`);
        if (plan.dueDate !== originalDate && plan.dueDate !== plannedDate) {
          await deleteCardPaymentOverride(plan.cardId, plan.dueDate);
        }
      } else if (amountCents === plan.originalAmountCents) {
        await deleteCardPaymentOverride(plan.cardId, plan.dueDate);
        if (plan.relatedDate && plan.relatedDate !== plan.dueDate) {
          await deleteCardPaymentOverride(plan.cardId, plan.relatedDate);
        }
      } else {
        await putCardPaymentOverride(plan.cardId, plannedDate, amountCents, null);
        if (plan.dueDate !== plannedDate) {
          await deleteCardPaymentOverride(plan.cardId, plan.dueDate);
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
      for (const date of dates) await deleteCardPaymentOverride(plan.cardId, date);
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

  // One-click delete of a user-scheduled card payment from its day detail.
  const deleteScheduledPaymentEvent = async (ev: ProjectionEvent, iso: string) => {
    if (!ev.sourceId) return;
    setSavingCardPayment(true);
    try {
      await deleteCardPaymentOverride(ev.sourceId, iso);
      // A moved payment also has a "moved-from" row at its original due date —
      // remove it too so the payment reverts to its natural due date.
      if (ev.relatedDate && ev.relatedDate !== iso) {
        await deleteCardPaymentOverride(ev.sourceId, ev.relatedDate);
      }
      toast.success("Scheduled payment deleted");
      setSelectedDate(null);
      router.refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSavingCardPayment(false);
    }
  };

  // Reschedule a dragged card payment to `toDate`, reusing the same override
  // mechanics as the PLAN / PROGRAM dialogs so behavior stays identical.
  const moveCardPaymentTo = async (drag: DragPayment, toDate: string) => {
    if (toDate === drag.fromDate) return;
    const error = cardPaymentMoveError(
      {
        fromDate: drag.fromDate,
        isPaydown: drag.isPaydown,
        paymentDueCents: drag.paymentDueCents,
        relatedDate: drag.relatedDate,
      },
      toDate,
      today,
    );
    if (error) {
      toast.error(error);
      return;
    }
    if (drag.isPaydown) {
      // Keep the paydown's target due date; just move the payment's own day.
      await saveScheduledPayment(drag.cardId, toDate, drag.amountCents, drag.paydownTargetDate, {
        cardId: drag.cardId,
        date: drag.fromDate,
      });
      return;
    }
    if (drag.paymentDueCents > 0) {
      // A real card due — reuse the "program payment" move (moved-to/moved-from).
      await saveCardPaymentPlan(
        {
          cardId: drag.cardId,
          label: drag.label,
          dueDate: drag.fromDate,
          relatedDate: drag.relatedDate,
          amountCents: drag.amountCents,
          originalAmountCents: drag.originalAmountCents,
          paymentDueCents: drag.paymentDueCents,
          paymentBalanceCents: drag.paymentBalanceCents,
          dueLabel: cardPaymentDueLabel(drag.label),
        },
        drag.amountCents,
        toDate,
      );
      return;
    }
    // A plain planned override — move the row (delete old, write new).
    await saveScheduledPayment(drag.cardId, toDate, drag.amountCents, undefined, {
      cardId: drag.cardId,
      date: drag.fromDate,
    });
  };

  const handlePaymentDragStart = (ev: ProjectionEvent, iso: string) =>
    setDragging(dragPaymentOf(ev, iso));
  const handlePaymentDragEnd = () => {
    setDragging(null);
    setDragOver(null);
  };
  const handleDayDragOver = (iso: string) => {
    if (!dragging) return;
    const valid =
      iso !== dragging.fromDate &&
      cardPaymentMoveError(
        {
          fromDate: dragging.fromDate,
          isPaydown: dragging.isPaydown,
          paymentDueCents: dragging.paymentDueCents,
          relatedDate: dragging.relatedDate,
        },
        iso,
        today,
      ) === null;
    setDragOver((prev) =>
      prev && prev.date === iso && prev.valid === valid ? prev : { date: iso, valid },
    );
  };
  const handleDayDrop = (iso: string) => {
    const drag = dragging;
    setDragging(null);
    setDragOver(null);
    if (drag) void moveCardPaymentTo(drag, iso);
  };

  // Shared drag-and-drop wiring for both the month and paycheck DayCell grids.
  const dragProps = {
    canDrag: canDragPayment,
    onPaymentDragStart: handlePaymentDragStart,
    onPaymentDragEnd: handlePaymentDragEnd,
    onDayDragOver: handleDayDragOver,
    onDayDrop: handleDayDrop,
    dragActive: dragging !== null,
    dragOverDate: dragOver?.date ?? null,
    dragOverValid: dragOver?.valid ?? false,
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden border border-[var(--border-raw)]">
            {(["month", "paycheck"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={cn(
                  "px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors",
                  view === v
                    ? "bg-[var(--mint)] text-[var(--bg-0)]"
                    : "bg-[var(--bg-1)] text-[var(--text-2)] hover:bg-[var(--bg-2)]",
                )}
              >
                {v}
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => (view === "month" ? moveMonth(-1) : moveCycle(-1))}
            aria-label={view === "month" ? "Previous month" : "Previous paycheck"}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => (view === "month" ? moveMonth(1) : moveCycle(1))}
            aria-label={view === "month" ? "Next month" : "Next paycheck"}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="outline" onClick={goToToday}>
            TODAY
          </Button>
          {view === "month" ? (
            <div className="ml-2 text-[18px] font-bold tracking-[0.08em] text-[var(--text-0)]">
              {MONTH_NAMES[month - 1]} <span className="text-[var(--text-2)]">{year}</span>
            </div>
          ) : activeCycle ? (
            <div className="ml-2 flex items-center gap-2 text-[16px] font-bold tracking-[0.02em] text-[var(--text-0)]">
              <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-3)]">
                Paycheck
              </span>
              <DateLabel iso={activeCycle.start} format="short" />
              <span className="text-[var(--text-3)]">→</span>
              <DateLabel iso={activeCycle.endInclusive} format="short" />
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-4 text-[12px]">
          <span className="text-[var(--text-3)]">
            IN <span className="tabular font-semibold text-[var(--mint)]"><Money cents={sumIncome} /></span>
          </span>
          <span className="text-[var(--text-3)]">
            OUT <span className="tabular font-semibold text-[var(--red)]"><Money cents={sumExpense} /></span>
          </span>
          <span className="text-[var(--text-3)]">
            NET{" "}
            <span
              className={cn(
                "tabular font-semibold",
                sumIncome - sumExpense >= 0 ? "text-[var(--mint)]" : "text-[var(--red)]",
              )}
            >
              <Money cents={sumIncome - sumExpense} />
            </span>
          </span>
        </div>
      </div>

      {view === "month" ? (
        <>
          {outsideWindow ? (
            <p className="text-[12px] text-[var(--text-3)]">
              This month is outside the projection window (
              <DateLabel iso={startDate} format="short" /> – <DateLabel iso={endDate} format="short" />
              ) — no scheduled events to show, but you can still click a day to add a bill or plan a card payment.
            </p>
          ) : null}

          <Card className="overflow-x-auto p-0">
            <div className="min-w-[720px]">
              <WeekdayHeader />
              <div className="grid grid-cols-7">
                {cells.map((iso, i) =>
                  iso ? (
                    <DayCell
                      key={iso}
                      iso={iso}
                      row={rowByDate.get(iso)}
                      today={today}
                      maxChips={MAX_CHIPS_PER_DAY}
                      minHeightClass="min-h-[104px]"
                      onSelect={setSelectedDate}
                      {...dragProps}
                    />
                  ) : (
                    <BlankCell key={`blank-${i}`} minHeightClass="min-h-[104px]" />
                  ),
                )}
              </div>
            </div>
          </Card>
        </>
      ) : activeCycle ? (
        <>
          <div className="grid grid-cols-2 gap-px overflow-hidden border border-[var(--border-raw)] bg-[var(--border-raw)] sm:grid-cols-3 lg:grid-cols-5">
            <CycleSummaryTile
              label="Paycheck in"
              value={<>+<Money cents={cycleIncome} /></>}
              valueClass="text-[var(--mint)]"
              sub={<DateLabel iso={activeCycle.start} format="short" />}
            />
            <CycleSummaryTile
              label="Cash out"
              value={<>−<Money cents={cycleExpense} /></>}
              valueClass="text-[var(--red)]"
              sub="bills + card payments"
            />
            <CycleSummaryTile
              label="Card payments"
              value={<>−<Money cents={cycleCardOut} /></>}
              valueClass="text-[var(--amber)]"
              sub="of cash out"
            />
            <CycleSummaryTile
              label="Left over"
              value={<Money cents={cycleIncome - cycleExpense} />}
              valueClass={cycleIncome - cycleExpense >= 0 ? "text-[var(--mint)]" : "text-[var(--red)]"}
              sub="income − cash out"
            />
            <CycleSummaryTile
              label="Lowest balance"
              value={cycleLowBalance != null ? <Money cents={cycleLowBalance} /> : "—"}
              valueClass={
                cycleLowBalance != null ? balanceToneClass(cycleLowBalance) : undefined
              }
              sub={
                cycleEndBalance != null ? (
                  <>
                    ends <Money cents={cycleEndBalance} />
                  </>
                ) : undefined
              }
            />
          </div>

          <Card className="overflow-x-auto p-0">
            <div className="min-w-[640px]">
              <WeekdayHeader />
              <div className="grid grid-cols-7">
                {cycleCells.map((iso, i) =>
                  iso ? (
                    <DayCell
                      key={iso}
                      iso={iso}
                      row={rowByDate.get(iso)}
                      today={today}
                      maxChips={null}
                      minHeightClass="min-h-[150px]"
                      onSelect={setSelectedDate}
                      {...dragProps}
                    />
                  ) : (
                    <BlankCell key={`blank-${i}`} minHeightClass="min-h-[150px]" />
                  ),
                )}
              </div>
            </div>
          </Card>
        </>
      ) : (
        <p className="text-[13px] text-[var(--text-2)]">
          No paychecks are projected in this window yet. Add a paycheck on the{" "}
          <span className="text-[var(--text-0)]">Paychecks</span> page to use the paycheck view.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 text-[10px] tracking-[0.12em] text-[var(--text-3)]">
        <span className={cn("rounded-[2px] border px-1.5 py-0.5", TONE_CLASSES.income)}>PAYCHECK / CREDIT</span>
        <span className={cn("rounded-[2px] border px-1.5 py-0.5", TONE_CLASSES.expense)}>BILL / EXPENSE</span>
        <span className={cn("rounded-[2px] border px-1.5 py-0.5", TONE_CLASSES.card)}>CARD PAYMENT</span>
        <span className={cn("rounded-[2px] border px-1.5 py-0.5", TONE_CLASSES.onCard)}>CHARGED TO CARD</span>
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
        open={
          selectedDate !== null &&
          addBillFor === null &&
          planningCardPayment === null &&
          schedulingPayment === null
        }
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
                    const isCardCharge = Boolean(ev.chargedToCardName);
                    const isCardPayment =
                      ev.sourceType === "creditCardPayment" && Boolean(ev.sourceId);
                    const isPaydown = isCardPayment && Boolean(ev.paydownTargetDate);
                    const paymentDueCents =
                      ev.paymentDueCents ?? ev.originalAmountCents ?? ev.amountCents;
                    const originalDueDate = ev.relatedDate ?? selectedDate;
                    const dueLabel = cardPaymentDueLabel(ev.label);
                    const statusLabel = ev.isPaid
                      ? "paid"
                      : isPastDay
                        ? "posted"
                        : isCardCharge
                          ? "on card"
                          : isPaydown
                            ? "planned payment"
                            : isCardPayment
                              ? paymentDueCents > 0
                                ? "card due"
                                : "card plan"
                              : ev.kind;
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
                            {statusLabel}
                          </div>
                          {isCardCharge ? (
                            <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-[var(--olive)]">
                              Charged to {ev.chargedToCardName} — carried by that card&apos;s payment,
                              no cash out this day
                            </div>
                          ) : null}
                          {isPaydown && !isPastDay && !ev.isPaid ? (
                            <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-[var(--amber)]">
                              Pays down the card payment due{" "}
                              <DateLabel iso={ev.paydownTargetDate!} format="short" />
                            </div>
                          ) : null}
                          {isCardPayment && !isPaydown && paymentDueCents > 0 ? (
                            <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-[var(--amber)]">
                              {dueLabel} · due <DateLabel iso={originalDueDate} format="short" /> ·{" "}
                              <Money cents={paymentDueCents} />
                            </div>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={cn("tabular text-[13px] font-semibold", TONE_TEXT[tone])}>
                            {isCardCharge ? "" : credit ? "+" : "−"}
                            <Money cents={displayCents(ev)} />
                          </span>
                          {isCardPayment && !ev.isPaid && !isPastDay ? (
                            isPaydown ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  setSchedulingPayment({
                                    date: selectedDate,
                                    cardId: ev.sourceId!,
                                    amountCents: ev.amountCents,
                                    existing: {
                                      cardId: ev.sourceId!,
                                      date: selectedDate,
                                      targetDate: ev.paydownTargetDate,
                                    },
                                  })
                                }
                              >
                                <CreditCard className="mr-1 h-3.5 w-3.5" /> EDIT PLAN
                              </Button>
                            ) : (
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
                            )
                          ) : null}
                          {isCardPayment &&
                          !ev.isPaid &&
                          !isPastDay &&
                          isScheduledPayment(ev, selectedDate) ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              title="Delete scheduled payment"
                              disabled={savingCardPayment}
                              onClick={() => void deleteScheduledPaymentEvent(ev, selectedDate)}
                            >
                              <Trash2 className="h-3.5 w-3.5 text-[var(--red)]" />
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
              <div className="flex flex-wrap justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setSelectedDate(null)}>
                  CLOSE
                </Button>
                {activeCards.length > 0 && selectedDate >= today ? (
                  <Button
                    variant="outline"
                    onClick={() => setSchedulingPayment({ date: selectedDate })}
                  >
                    <CreditCard className="mr-1 h-4 w-4" /> PLAN CARD PAYMENT
                  </Button>
                ) : null}
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

      {schedulingPayment ? (
        <ScheduleCardPaymentDialog
          draft={schedulingPayment}
          cards={activeCards}
          today={today}
          findTarget={findNextCardPayment}
          saving={savingCardPayment}
          onClose={() => setSchedulingPayment(null)}
          onSave={saveScheduledPayment}
          onDelete={removeScheduledPayment}
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
            <div className="flex gap-2 border border-[var(--amber)]/50 bg-[var(--amber)]/10 p-3 text-[11px] text-[var(--amber)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Programmed payment exceeds the displayed card balance — that&apos;s fine if
                you&apos;re covering transactions that haven&apos;t posted yet.
              </span>
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
              disabled={saving || amountCents <= 0 || !plannedDate || afterDueDate || beforeToday}
            >
              {saving ? "SAVING…" : "SAVE PAYMENT PLAN"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleCardPaymentDialog({
  draft,
  cards,
  today,
  findTarget,
  saving,
  onClose,
  onSave,
  onDelete,
}: {
  draft: SchedulePaymentDraft;
  cards: ReadonlyArray<{ id: string; name: string }>;
  today: string;
  findTarget: (cardId: string, fromDate: string) => NextCardPayment | undefined;
  saving: boolean;
  onClose: () => void;
  onSave: (
    cardId: string,
    date: string,
    amountCents: number,
    targetDate: string | undefined,
    previous?: { cardId: string; date: string },
  ) => Promise<void>;
  onDelete: (cardId: string, date: string) => Promise<void>;
}) {
  const [cardId, setCardId] = React.useState(draft.cardId ?? cards[0]?.id ?? "");
  const [date, setDate] = React.useState(draft.date);
  const [amountCents, setAmountCents] = React.useState(draft.amountCents ?? 0);

  const target = cardId ? findTarget(cardId, date) : undefined;
  // When editing, the projection already subtracted this plan from its target
  // slot — add it back so "amount due" reflects the due without this plan.
  const editBackCents =
    draft.existing &&
    draft.existing.cardId === cardId &&
    draft.existing.targetDate === target?.date
      ? (draft.amountCents ?? 0)
      : 0;
  const dueCents = target ? target.dueCents + editBackCents : 0;
  const remainderCents = target ? Math.max(0, dueCents - amountCents) : 0;
  const beforeToday = date < today;
  const exceedsBalance =
    target?.balanceCents != null && amountCents > target.balanceCents + editBackCents;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <CardSubTag>SCHEDULE_CARD_PAYMENT</CardSubTag>
          <DialogTitle>PLAN CARD PAYMENT</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            void onSave(cardId, date, amountCents, target?.date, draft.existing);
          }}
        >
          <div className="space-y-1.5">
            <Label>CARD</Label>
            <Select value={cardId} onValueChange={setCardId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {cards.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {target ? (
            <div className="grid gap-3 border border-[var(--border-raw)] bg-[var(--bg-2)] p-3 text-[10px] uppercase tracking-[0.14em] text-[var(--text-2)]">
              <div className="flex items-center justify-between gap-3">
                <span>Next card payment</span>
                <span className="text-[var(--amber)]">
                  <DateLabel iso={target.date} format="short" />
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Amount due that day</span>
                <span className="font-bold tabular text-[var(--text-0)]">
                  <Money cents={dueCents} />
                </span>
              </div>
              {target.balanceCents != null ? (
                <div className="flex items-center justify-between gap-3">
                  <span>Displayed card balance</span>
                  <span className="tabular text-[var(--text-0)]">
                    <Money cents={target.balanceCents} />
                  </span>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-[11px] text-[var(--text-3)]">
              No upcoming payment is projected for this card — the amount will be scheduled as an
              extra planned payment on the chosen day.
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="schedule-card-payment-date">PAYMENT DATE</Label>
            <Input
              id="schedule-card-payment-date"
              type="date"
              min={today}
              value={date}
              onChange={(event) => setDate(event.target.value)}
              disabled={saving}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="schedule-card-payment-amount">PAYMENT AMOUNT</Label>
            <MoneyInput
              id="schedule-card-payment-amount"
              valueCents={amountCents}
              onChangeCents={setAmountCents}
              disabled={saving}
            />
            {target ? (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setAmountCents(dueCents)}
                  disabled={saving}
                >
                  PAY AMOUNT DUE
                </Button>
                {target.balanceCents != null ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setAmountCents(target.balanceCents!)}
                    disabled={saving}
                  >
                    PAY CARD BALANCE
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          {target && amountCents > 0 && remainderCents > 0 ? (
            <div className="border border-[var(--amber)]/50 bg-[var(--amber)]/10 p-3 text-[11px] text-[var(--amber)]">
              The remaining <Money cents={remainderCents} /> stays due on{" "}
              <DateLabel iso={target.date} format="short" /> — this payment reduces it, it
              doesn&apos;t replace it.
            </div>
          ) : null}
          {target && amountCents >= dueCents && dueCents > 0 ? (
            <div className="border border-[var(--mint-dim)] bg-[var(--mint-glow)] p-3 text-[11px] text-[var(--mint)]">
              Covers everything due on <DateLabel iso={target.date} format="short" /> — nothing
              left to pay that day.
            </div>
          ) : null}
          {beforeToday ? (
            <div className="flex gap-2 border border-[var(--red)]/50 bg-[var(--red)]/10 p-3 text-[11px] text-[var(--red)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Choose today or a future date.</span>
            </div>
          ) : null}
          {exceedsBalance ? (
            <div className="flex gap-2 border border-[var(--amber)]/50 bg-[var(--amber)]/10 p-3 text-[11px] text-[var(--amber)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Scheduled payment exceeds the displayed card balance — that&apos;s fine if
                you&apos;re covering transactions that haven&apos;t posted yet.
              </span>
            </div>
          ) : null}

          <p className="text-[11px] text-[var(--text-3)]">
            This updates the Finance_OS cash-flow plan. It does not submit a payment to PayPal or
            the card issuer.
          </p>

          <DialogFooter>
            {draft.existing ? (
              <Button
                type="button"
                variant="destructive"
                onClick={() => void onDelete(draft.existing!.cardId, draft.existing!.date)}
                disabled={saving}
              >
                REMOVE
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
              disabled={saving || !cardId || amountCents <= 0 || !date || beforeToday}
            >
              {saving ? "SAVING…" : "SCHEDULE PAYMENT"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
