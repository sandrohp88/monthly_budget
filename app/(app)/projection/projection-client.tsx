"use client";

import * as React from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { CardSubTag } from "@/components/ui/page-head";
import { Tile, TileGrid } from "@/components/ui/tile";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
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

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Tab key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}
          </Tab>
        ))}
        <div className="ml-auto text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]">
          <DateLabel iso={range.start} format="short" /> – <DateLabel iso={range.end} format="short" />
          {" · "}
          {windowRows.length} DAY{windowRows.length === 1 ? "" : "S"}
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

      <Card>
        <CardHeader>
          <div>
            <CardSubTag>LEDGER_VIRTUAL</CardSubTag>
            <CardTitle className="mt-0.5">DAILY PROJECTION</CardTitle>
          </div>
          <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]">
            {eventRows.length} EVENT DAY{eventRows.length === 1 ? "" : "S"} · {windowRows.length} TOTAL
          </div>
        </CardHeader>
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full text-[11px] font-mono tabular">
            <thead className="sticky top-0 z-10 bg-[var(--bg-1)]">
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
              {eventRows.map((r) => {
                const isPayday = r.events.some((e) => e.kind === "paycheck");
                const isWorst = r.date === worstDate;
                const rowClass = cn(
                  "border-b border-[var(--border-raw)] last:border-0 transition-colors",
                  isWorst
                    ? "bg-[rgba(239,68,68,0.18)] border-l-2 border-l-[var(--red)]"
                    : isPayday
                      ? "bg-[rgba(74,222,128,0.06)]"
                      : "bg-[rgba(74,222,128,0.025)]",
                );
                return (
                  <tr id={`d-${r.date}`} key={r.date} className={rowClass}>
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
                      {isPayday ? "▸ " : ""}
                      {describeEvents(r.events)}
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
            </tbody>
          </table>
        </div>
      </Card>
    </>
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
