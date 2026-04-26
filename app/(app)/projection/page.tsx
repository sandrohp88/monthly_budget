import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { buildProjection } from "@/lib/projection-server";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { CardSubTag, PageHead } from "@/components/ui/page-head";
import { Tile, TileGrid } from "@/components/ui/tile";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import { describeEvents, findWorstDay } from "@/lib/projection";
import { cn } from "@/lib/cn";

export const dynamic = "force-dynamic";

function balanceClass(cents: number) {
  if (cents < 0) return "text-[var(--red)]";
  if (cents < 50000) return "text-[var(--amber)]";
  return "text-[var(--mint)]";
}

export default async function ProjectionPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const projection = await buildProjection(userId);
  if (!projection) redirect("/setup");
  const { rows, startDate, endDate } = projection;

  const startBal = projection.startingBalanceCents;
  const endBal = rows[rows.length - 1]?.balanceCents ?? startBal;
  const peak =
    rows.length > 0
      ? rows.reduce((p, r) => (r.balanceCents > p.balanceCents ? r : p), rows[0]!)
      : null;
  const trough = findWorstDay(rows);
  const worstDate = trough?.date;

  return (
    <div className="space-y-6 fade-in">
      <PageHead
        module="MODULE_05"
        title="PROJECTION"
        subtitle={
          <>
            Daily ledger · <DateLabel iso={startDate} format="short" /> –{" "}
            <DateLabel iso={endDate} format="short" /> · {rows.length} days
          </>
        }
      />

      <TileGrid cols={4}>
        <Tile
          label="START"
          value={<Money cents={startBal} />}
          delta={<DateLabel iso={startDate} format="short" />}
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
          value={<Money cents={endBal} />}
          delta={<DateLabel iso={endDate} format="short" />}
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
            {rows.length} ROWS · COMPUTED DAILY
          </div>
        </CardHeader>
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full text-[11px] font-mono tabular">
            <thead className="sticky top-0 z-10 bg-[var(--bg-1)]">
              <tr className="border-b border-[var(--border-raw)]">
                <th className="px-4 py-3 text-left text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-3)]">
                  DATE
                </th>
                <th className="px-4 py-3 text-left text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-3)]">
                  DESCRIPTION
                </th>
                <th className="px-4 py-3 text-right text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-3)]">
                  INCOME
                </th>
                <th className="px-4 py-3 text-right text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-3)]">
                  EXPENSE
                </th>
                <th className="px-4 py-3 text-right text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-3)]">
                  BALANCE
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isPayday = r.events.some((e) => e.kind === "paycheck");
                const isWorst = r.date === worstDate;
                const hasEvents = r.events.length > 0;
                const rowClass = cn(
                  "border-b border-[var(--border-raw)] last:border-0 transition-colors",
                  isWorst
                    ? "bg-[rgba(239,68,68,0.18)] border-l-2 border-l-[var(--red)]"
                    : isPayday
                      ? "bg-[rgba(74,222,128,0.06)]"
                      : hasEvents
                        ? "bg-[rgba(74,222,128,0.025)]"
                        : "",
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
                      {hasEvents ? (
                        <>
                          {isPayday ? "▸ " : ""}
                          {describeEvents(r.events)}
                        </>
                      ) : (
                        <span className="text-[var(--text-3)]">—</span>
                      )}
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
                    <td className={cn("px-4 py-3 text-right font-bold", balanceClass(r.balanceCents))}>
                      <Money cents={r.balanceCents} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
