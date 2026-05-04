"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CardSubTag } from "@/components/ui/page-head";
import { StatusPill } from "@/components/ui/status-pill";
import { Tile, TileGrid } from "@/components/ui/tile";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import { ProjectionChart } from "@/components/projection-chart";
import { describeEvents, findWorstDay, type ProjectionRow } from "@/lib/projection";
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

function riskLabel(cents: number): { label: string; variant: "default" | "amber" | "danger" } {
  if (cents < 0) return { label: "BREACH", variant: "danger" };
  if (cents < 50000) return { label: "LOW BUFFER", variant: "amber" };
  return { label: "NOMINAL", variant: "default" };
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
  const [filter, setFilter] = React.useState<FilterKey>("ALL");

  const range = React.useMemo(
    () => rangeForFilter(filter, today, startDate, endDate),
    [filter, today, startDate, endDate],
  );

  // All rows in the filter window (every day, including no-event days) — used
  // for tile math (peak/trough/start/end) so the numbers reflect the picker.
  const windowRows = React.useMemo(
    () => rows.filter((r) => r.date >= range.start && r.date <= range.end),
    [rows, range.start, range.end],
  );

  // The visible ledger rows — only days where money moved
  const eventRows = React.useMemo(
    () => windowRows.filter((r) => r.incomeCents > 0 || r.expenseCents > 0),
    [windowRows],
  );
  const ledgerSections = React.useMemo(() => buildLedgerSections(eventRows), [eventRows]);

  // Tile derivations (off windowRows, not eventRows, so balance peaks between
  // events still register correctly)
  const startBal = windowRows[0]?.balanceCents ?? 0;
  const endBal = windowRows[windowRows.length - 1]?.balanceCents ?? startBal;
  const peak =
    windowRows.length > 0
      ? windowRows.reduce((p, r) => (r.balanceCents > p.balanceCents ? r : p), windowRows[0]!)
      : null;
  const trough = findWorstDay(windowRows);
  const worstDate = trough?.date;
  const risk = riskLabel(trough?.balanceCents ?? endBal);
  const totals = React.useMemo(
    () =>
      windowRows.reduce(
        (acc, row) => ({
          incomeCents: acc.incomeCents + row.incomeCents,
          expenseCents: acc.expenseCents + row.expenseCents,
          activeDays: acc.activeDays + (row.incomeCents > 0 || row.expenseCents > 0 ? 1 : 0),
        }),
        { incomeCents: 0, expenseCents: 0, activeDays: 0 },
      ),
    [windowRows],
  );
  const netCents = totals.incomeCents - totals.expenseCents;

  return (
    <div className="space-y-5">
      <div className="bracketed relative overflow-hidden rounded-sm border border-[var(--border-raw)] bg-[linear-gradient(135deg,rgba(0,229,255,0.10),rgba(14,19,24,0.92)_42%,rgba(57,255,20,0.05))] p-3">
        <div className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.025)_0,rgba(255,255,255,0.025)_1px,transparent_1px,transparent_54px)]" />
        <div className="relative flex flex-wrap items-center gap-2">
          <div className="mr-2 text-[9px] uppercase tracking-[0.2em] text-[var(--text-3)]">
            WINDOW_SELECT
          </div>
          {FILTERS.map((f) => (
            <Tab key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
            </Tab>
          ))}
          <div className="ml-auto flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]">
            <StatusPill variant={risk.variant}>{risk.label}</StatusPill>
            <span>
              <DateLabel iso={range.start} format="short" /> – <DateLabel iso={range.end} format="short" />
              {" · "}
              {windowRows.length} DAY{windowRows.length === 1 ? "" : "S"}
            </span>
          </div>
        </div>
      </div>

      <TileGrid cols={4}>
        <Tile
          label="START"
          value={<Money cents={startBal} />}
          delta={
            windowRows[0] ? <DateLabel iso={windowRows[0].date} format="short" /> : null
          }
        />
        <Tile
          label="PEAK"
          value={peak ? <Money cents={peak.balanceCents} /> : "—"}
          delta={peak ? <DateLabel iso={peak.date} format="short" /> : null}
          variant="mint"
        />
        <Tile
          label="TROUGH"
          value={trough ? <Money cents={trough.balanceCents} /> : "—"}
          delta={trough ? <DateLabel iso={trough.date} format="short" /> : null}
          variant={trough && trough.balanceCents < 50000 ? "red" : "default"}
        />
        <Tile
          label="END"
          value={
            windowRows[windowRows.length - 1] ? <Money cents={endBal} /> : "—"
          }
          delta={
            windowRows[windowRows.length - 1] ? (
              <DateLabel iso={windowRows[windowRows.length - 1]!.date} format="short" />
            ) : null
          }
          variant={endBal >= startBal ? "mint" : "red"}
        />
      </TileGrid>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(280px,0.8fr)]">
        <Card className="overflow-hidden border-[rgba(0,229,255,0.24)] bg-[linear-gradient(180deg,rgba(0,229,255,0.06),rgba(14,19,24,0.96)_36%)]">
          <CardHeader>
            <div>
              <CardSubTag>CHART_05</CardSubTag>
              <CardTitle className="mt-0.5">BALANCE TRACE</CardTitle>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]">
              <StatusPill variant={netCents >= 0 ? "default" : "danger"}>
                NET {netCents >= 0 ? "+" : "-"}
                <Money cents={Math.abs(netCents)} />
              </StatusPill>
              <span>{totals.activeDays} EVENT DAYS</span>
            </div>
          </CardHeader>
          <CardContent className="pt-5">
            <ProjectionChart
              data={windowRows.map((r) => ({ date: r.date, balanceCents: r.balanceCents }))}
            />
          </CardContent>
        </Card>

        <Card className="overflow-hidden bg-[linear-gradient(160deg,rgba(57,255,20,0.06),rgba(14,19,24,0.92)_48%,rgba(251,191,36,0.05))]">
          <CardHeader>
            <div>
              <CardSubTag>READOUT_05</CardSubTag>
              <CardTitle className="mt-0.5">WINDOW TELEMETRY</CardTitle>
            </div>
            <StatusPill variant={risk.variant}>{risk.label}</StatusPill>
          </CardHeader>
          <CardContent className="space-y-3">
            <TelemetryRow label="INFLOW" value={<Money cents={totals.incomeCents} />} variant="mint" />
            <TelemetryRow label="OUTFLOW" value={<Money cents={totals.expenseCents} />} variant="red" />
            <TelemetryRow
              label="NET DRIFT"
              value={
                <span className={netCents >= 0 ? "text-[var(--mint)]" : "text-[var(--red)]"}>
                  {netCents >= 0 ? "+" : "-"}
                  <Money cents={Math.abs(netCents)} />
                </span>
              }
            />
            <TelemetryRow
              label="WORST DAY"
              value={trough ? <Money cents={trough.balanceCents} /> : "—"}
              detail={trough ? <DateLabel iso={trough.date} format="short" /> : undefined}
              variant={risk.variant === "danger" ? "red" : risk.variant === "amber" ? "amber" : "mint"}
            />
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader>
          <div>
            <CardSubTag>LEDGER_VIRTUAL</CardSubTag>
            <CardTitle className="mt-0.5">DAILY PROJECTION</CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]">
            <StatusPill variant="off">{eventRows.length} EVENTS</StatusPill>
            <StatusPill variant="off">{ledgerSections.length} PAY PERIODS</StatusPill>
            <span>{windowRows.length} TOTAL DAYS</span>
          </div>
        </CardHeader>
        <div className="max-h-[70vh] overflow-auto">
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
                    const isWorst = r.date === worstDate;
                    const fundedByLabel = section.isOpeningBalance
                      ? "OPENING BALANCE"
                      : `PAYCHECK ${section.sourceDate?.slice(5)}`;
                    const rowClass = cn(
                      "border-b border-[var(--border-raw)] last:border-0 transition-colors hover:bg-[rgba(0,229,255,0.08)]",
                      "border-l-2",
                      section.isOpeningBalance ? "border-l-[var(--amber)]" : "border-l-[var(--mint-dim)]",
                      isWorst
                        ? "bg-[rgba(239,68,68,0.18)] border-l-[var(--red)]"
                        : isPayday
                          ? "bg-[rgba(57,255,20,0.085)]"
                          : "bg-[rgba(0,229,255,0.018)]",
                    );
                    return (
                      <tr id={`d-${r.date}`} key={`${section.key}-${r.date}`} className={rowClass}>
                        <td
                          className={cn(
                            "whitespace-nowrap px-4 py-3 font-semibold uppercase tracking-tight",
                            isWorst
                              ? "text-[var(--red)]"
                              : isPayday
                                ? "text-[var(--mint)]"
                                : "text-[var(--text-1)]",
                          )}
                        >
                          {isWorst ? "⚠ " : ""}
                          <DateLabel iso={r.date} format="short" />
                        </td>
                        <td
                          className={cn(
                            "px-4 py-3",
                            isWorst
                              ? "text-[var(--red)] font-semibold"
                              : isPayday
                                ? "text-[var(--mint)] font-semibold"
                                : "text-[var(--text-1)]",
                          )}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            {isWorst ? <StatusPill variant="danger">TROUGH</StatusPill> : null}
                            {isPayday ? <StatusPill>PAYCHECK SOURCE</StatusPill> : null}
                            {!isPayday && r.expenseCents > 0 ? (
                              <StatusPill variant={section.isOpeningBalance ? "amber" : "off"}>
                                FUNDED BY {fundedByLabel}
                              </StatusPill>
                            ) : null}
                            <span>{describeEvents(r.events)}</span>
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
      </Card>
    </div>
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
    <tr className="border-y border-[rgba(0,229,255,0.28)] bg-[linear-gradient(90deg,rgba(0,229,255,0.14),rgba(14,19,24,0.96)_48%,rgba(57,255,20,0.06))]">
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

function TelemetryRow({
  label,
  value,
  detail,
  variant = "default",
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  detail?: React.ReactNode;
  variant?: "default" | "mint" | "red" | "amber";
}) {
  const color =
    variant === "mint"
      ? "text-[var(--mint)]"
      : variant === "red"
        ? "text-[var(--red)]"
        : variant === "amber"
          ? "text-[var(--amber)]"
          : "text-[var(--text-0)]";

  return (
    <div className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-card)] px-3 py-2.5">
      <div className="mb-1 text-[9px] uppercase tracking-[0.18em] text-[var(--text-3)]">{label}</div>
      <div className={cn("text-[20px] font-bold leading-none tabular", color)}>{value}</div>
      {detail ? (
        <div className="mt-1.5 text-[10px] uppercase tracking-[0.12em] text-[var(--text-2)]">
          {detail}
        </div>
      ) : null}
    </div>
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
