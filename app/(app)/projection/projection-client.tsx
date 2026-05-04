"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import type { ProjectionRow } from "@/lib/projection";
import { addDaysIso } from "@/lib/dates";
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
  "Projected balance is negative after this day's income and expenses. The bills due by this row exceed the cash available to pay them.";

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

function rangeForFilter(
  filter: FilterKey,
  today: string,
  fullStart: string,
  fullEnd: string,
): { start: string; end: string } {
  if (filter === "ALL") return { start: fullStart, end: fullEnd };
  const start = today;
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

type BillAdjustment = {
  billId: string;
  billName: string;
  dueDate: string;
  amountCents: number;
  originalAmountCents: number;
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
}: {
  rows: ProjectionRow[];
  startDate: string;
  endDate: string;
  today: string;
}) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<FilterKey>("ALL");
  const [adjustingBill, setAdjustingBill] = React.useState<BillAdjustment | null>(null);
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

  // The visible ledger rows — only days where money moved
  const eventRows = React.useMemo(
    () => windowRows.filter((r) => r.events.length > 0),
    [windowRows],
  );
  const ledgerSections = React.useMemo(() => buildLedgerSections(eventRows), [eventRows]);

  const saveBillAdjustment = async (adjustment: BillAdjustment, amountCents: number) => {
    setSavingAdjustment(true);
    try {
      const qs = new URLSearchParams({ dueDate: adjustment.dueDate });
      const res =
        amountCents === adjustment.originalAmountCents
          ? await fetch(`/api/bills/${adjustment.billId}/payment-overrides?${qs}`, {
              method: "DELETE",
            })
          : await fetch(`/api/bills/${adjustment.billId}/payment-overrides`, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ dueDate: adjustment.dueDate, amountCents }),
            });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "save failed");
      toast.success(
        amountCents === adjustment.originalAmountCents
          ? "Planned payment reset"
          : "Planned payment updated",
      );
      setAdjustingBill(null);
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSavingAdjustment(false);
    }
  };

  const resetBillAdjustment = async (adjustment: BillAdjustment) => {
    setSavingAdjustment(true);
    try {
      const qs = new URLSearchParams({ dueDate: adjustment.dueDate });
      const res = await fetch(`/api/bills/${adjustment.billId}/payment-overrides?${qs}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "reset failed");
      toast.success("Planned payment reset");
      setAdjustingBill(null);
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
                    No income or expense events in this window
                  </td>
                </tr>
              ) : null}
              {ledgerSections.map((section, sectionIndex) => (
                <React.Fragment key={section.key}>
                  <PaycheckSectionHeader section={section} index={sectionIndex} />
                  {section.rows.map((r) => {
                    const isPayday = hasPaycheck(r);
                    const isNegativeBalance = r.balanceCents < 0;
                    const fundedByLabel = section.isOpeningBalance
                      ? "OPENING BALANCE"
                      : `PAYCHECK ${section.sourceDate?.slice(5)}`;
                    const rowClass = cn(
                      "border-b border-[var(--border-raw)] last:border-0 transition-colors hover:bg-[var(--cyan-tint-hover)]",
                      "border-l-2",
                      section.isOpeningBalance ? "border-l-[var(--amber)]" : "border-l-[var(--mint-dim)]",
                      isNegativeBalance
                        ? "bg-[var(--red-glow)] border-l-[var(--red)]"
                        : isPayday
                          ? "bg-[var(--phosphor-tint-row)]"
                          : "bg-[var(--cyan-tint-zebra)]",
                    );
                    return (
                      <tr id={`d-${r.date}`} key={`${section.key}-${r.date}`} className={rowClass}>
                        <td
                          className={cn(
                            "whitespace-nowrap px-4 py-3 font-semibold uppercase tracking-tight",
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
                        <td
                          className={cn(
                            "px-4 py-3",
                            isNegativeBalance
                              ? "text-[var(--red)] font-semibold"
                              : isPayday
                                ? "text-[var(--mint)] font-semibold"
                                : "text-[var(--text-1)]",
                          )}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            {isNegativeBalance ? (
                              <StatusPill variant="danger">NEGATIVE</StatusPill>
                            ) : null}
                            {isPayday ? <StatusPill>PAYCHECK SOURCE</StatusPill> : null}
                            {!isPayday && r.expenseCents > 0 ? (
                              <StatusPill variant={section.isOpeningBalance ? "amber" : "off"}>
                                FUNDED BY {fundedByLabel}
                              </StatusPill>
                            ) : null}
                            <ProjectionEventList
                              row={r}
                              onAdjustBill={setAdjustingBill}
                            />
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {r.incomeCents > 0 ? (
                            <span className="text-[var(--mint)] font-semibold">
                              +<Money cents={r.incomeCents} />
                            </span>
                          ) : (
                            <span className="text-[var(--text-3)]">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {r.expenseCents > 0 ? (
                            <span className="text-[var(--red)] font-semibold">
                              −<Money cents={r.expenseCents} />
                            </span>
                          ) : (
                            <span className="text-[var(--text-3)]">—</span>
                          )}
                        </td>
                        <td
                          className={cn(
                            "px-4 py-3 text-right font-bold",
                            balanceClass(r.balanceCents),
                          )}
                        >
                          <Money cents={r.balanceCents} />
                        </td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              ))}
            </tbody>
          </table>
      </div>
      {adjustingBill ? (
        <BillPaymentAdjustmentDialog
          adjustment={adjustingBill}
          saving={savingAdjustment}
          onClose={() => setAdjustingBill(null)}
          onSave={saveBillAdjustment}
          onReset={resetBillAdjustment}
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

function ProjectionEventList({
  row,
  onAdjustBill,
}: {
  row: ProjectionRow;
  onAdjustBill: (adjustment: BillAdjustment) => void;
}) {
  return (
    <>
      {row.events.map((event, index) => {
        if (event.kind !== "bill" || !event.sourceId || event.originalAmountCents == null) {
          return <span key={`${event.kind}-${event.label}-${index}`}>{event.label}</span>;
        }

        const adjusted = event.amountCents !== event.originalAmountCents;
        return (
          <span
            key={`${event.sourceId}-${row.date}-${index}`}
            className="inline-flex flex-wrap items-center gap-1.5"
          >
            <StatusPill variant={adjusted ? "amber" : "off"}>
              {adjusted ? "PLANNED" : "BILL"}
            </StatusPill>
            <button
              type="button"
              onClick={() =>
                onAdjustBill({
                  billId: event.sourceId!,
                  billName: event.label,
                  dueDate: row.date,
                  amountCents: event.amountCents,
                  originalAmountCents: event.originalAmountCents!,
                })
              }
              className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--text-1)] hover:border-[var(--mint-dim)] hover:text-[var(--text-0)]"
            >
              {event.label} <Money cents={event.amountCents} />
            </button>
            {adjusted ? (
              <span className="text-[9px] uppercase tracking-[0.12em] text-[var(--text-3)]">
                BASE <Money cents={event.originalAmountCents} />
              </span>
            ) : null}
          </span>
        );
      })}
    </>
  );
}

function BillPaymentAdjustmentDialog({
  adjustment,
  saving,
  onClose,
  onSave,
  onReset,
}: {
  adjustment: BillAdjustment;
  saving: boolean;
  onClose: () => void;
  onSave: (adjustment: BillAdjustment, amountCents: number) => Promise<void>;
  onReset: (adjustment: BillAdjustment) => Promise<void>;
}) {
  const [amountCents, setAmountCents] = React.useState(adjustment.amountCents);
  const adjusted = adjustment.amountCents !== adjustment.originalAmountCents;

  React.useEffect(() => {
    setAmountCents(adjustment.amountCents);
  }, [adjustment]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <CardSubTag>BILL_PAYMENT_PLAN</CardSubTag>
          <DialogTitle>{adjustment.billName.toUpperCase()}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4 pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            void onSave(adjustment, amountCents);
          }}
        >
          <div className="grid gap-3 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] p-3 text-[10px] uppercase tracking-[0.14em] text-[var(--text-2)]">
            <div className="flex items-center justify-between gap-3">
              <span>Due date</span>
              <span className="text-[var(--text-0)]">
                <DateLabel iso={adjustment.dueDate} format="short" />
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Normal bill</span>
              <span className="text-[var(--text-0)]">
                <Money cents={adjustment.originalAmountCents} />
              </span>
            </div>
          </div>

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
          </div>

          <DialogFooter>
            {adjusted ? (
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
              <Button type="submit" variant="primary" disabled={saving || amountCents < 0}>
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
