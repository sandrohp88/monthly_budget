"use client";

// Forward-looking view of what the cards will cost over the coming months:
// what's due each month, per card, how much of it is already covered by
// scheduled cash, and how much is still exposed to interest.

import * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tile, TileGrid } from "@/components/ui/tile";
import { EmptyState } from "@/components/ui/empty-state";
import { Money } from "@/components/money";
import { CardForecastChart, type CardForecastSeries } from "@/components/card-forecast-chart";
import type { CardForecast } from "@/lib/card-forecast";
import { CalendarClock } from "lucide-react";

/** Chart/table series colors, assigned by per-card obligation size. */
const SERIES_COLORS = ["#06b6d4", "#a855f7", "#f97316", "#22c55e", "#ec4899", "#eab308", "#6b7280"];

function monthLabel(ym: string, style: "short" | "long"): string {
  const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1));
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: style === "long" ? "numeric" : undefined,
    timeZone: "UTC",
  }).format(d);
}

export function CardForecastView({ forecast }: { forecast: CardForecast }) {
  const { months, cards, total } = forecast;

  const series: CardForecastSeries[] = cards.map((c, i) => ({
    cardId: c.cardId,
    cardName: c.cardName,
    color: SERIES_COLORS[i % SERIES_COLORS.length]!,
  }));
  const colorByCardId = new Map(series.map((s) => [s.cardId, s.color]));

  const chartData = months.map((m) => {
    const row: Record<string, string | number> = { month: monthLabel(m.month, "short") };
    for (const c of cards) row[c.cardId] = m.byCardId[c.cardId]?.dueCents ?? 0;
    return row;
  });

  const uncoveredCents = Math.max(0, total.dueCents - total.coveredCents);
  const nextMonth = months[1];
  const monthsWithDue = months.filter((m) => m.dueCents > 0).length;
  const avgMonthlyCents = monthsWithDue > 0 ? Math.round(total.dueCents / monthsWithDue) : 0;

  if (cards.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<CalendarClock className="h-5 w-5" />}
          title="Nothing due in this window"
          description="Once a card has a statement, a live balance, or a promo balance, its upcoming cycles show up here month by month."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <TileGrid cols="auto">
        <Tile
          compact
          label={`Due through ${monthLabel(forecast.throughMonth, "long")}`}
          value={<Money cents={total.dueCents} />}
          delta={`${months.length} month${months.length === 1 ? "" : "s"} · ${cards.length} card${cards.length === 1 ? "" : "s"}`}
        />
        <Tile
          compact
          label="Average per month"
          value={<Money cents={avgMonthlyCents} />}
          delta={
            monthsWithDue > 0
              ? `across ${monthsWithDue} month${monthsWithDue === 1 ? "" : "s"} with a due date`
              : "no due dates in range"
          }
        />
        <Tile
          compact
          label="Not yet covered"
          value={<Money cents={uncoveredCents} />}
          variant={uncoveredCents > 0 ? "amber" : "mint"}
          delta={
            uncoveredCents > 0 ? (
              <>
                <Money cents={total.coveredCents} /> already scheduled
              </>
            ) : (
              "every due date has scheduled cash"
            )
          }
        />
        <Tile
          compact
          label={nextMonth ? monthLabel(nextMonth.month, "long") : "Next month"}
          value={nextMonth ? <Money cents={nextMonth.dueCents} /> : <span className="text-[var(--text-2)]">—</span>}
          delta={
            nextMonth && nextMonth.dueCents > 0 ? (
              <>
                <Money cents={Math.max(0, nextMonth.dueCents - nextMonth.coveredCents)} /> uncovered
              </>
            ) : (
              "nothing due"
            )
          }
        />
      </TileGrid>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>What the cards add up to</CardTitle>
            <CardDescription>
              Each month&apos;s due dates, stacked by card. Cycles with no recorded statement yet use
              the carried-forward balance estimate, so they read as a monthly run rate.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          <CardForecastChart data={chartData} series={series} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Month by month</CardTitle>
            <CardDescription>
              Due per card, what you&apos;ve scheduled against it, and what&apos;s still exposed.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                {cards.map((c) => (
                  <TableHead key={c.cardId} className="text-right">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ background: colorByCardId.get(c.cardId) }}
                      />
                      {c.cardName}
                    </span>
                  </TableHead>
                ))}
                <TableHead className="text-right">Total due</TableHead>
                <TableHead className="text-right">Scheduled</TableHead>
                <TableHead className="text-right">Uncovered</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {months.map((m) => {
                const uncovered = Math.max(0, m.dueCents - m.coveredCents);
                return (
                  <TableRow key={m.month}>
                    <TableCell className="font-medium text-[var(--text-0)]">
                      {monthLabel(m.month, "long")}
                    </TableCell>
                    {cards.map((c) => {
                      const cell = m.byCardId[c.cardId];
                      return (
                        <TableCell key={c.cardId} className="text-right">
                          {cell && cell.dueCents > 0 ? (
                            <Money cents={cell.dueCents} />
                          ) : (
                            <span className="text-[var(--text-3)]">—</span>
                          )}
                        </TableCell>
                      );
                    })}
                    <TableCell
                      className={
                        m.dueCents > 0
                          ? "text-right font-semibold text-[var(--text-0)]"
                          : "text-right text-[var(--text-3)]"
                      }
                    >
                      {m.dueCents > 0 ? <Money cents={m.dueCents} /> : "—"}
                    </TableCell>
                    <TableCell className="text-right text-[var(--text-2)]">
                      {m.coveredCents > 0 ? (
                        <Money cents={m.coveredCents} />
                      ) : (
                        <span className="text-[var(--text-3)]">—</span>
                      )}
                    </TableCell>
                    <TableCell
                      className={
                        uncovered > 0 ? "text-right text-[var(--amber)]" : "text-right text-[var(--text-3)]"
                      }
                    >
                      {uncovered > 0 ? <Money cents={uncovered} /> : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell>Total</TableCell>
                {cards.map((c) => (
                  <TableCell key={c.cardId} className="text-right">
                    <Money cents={c.dueCents} />
                  </TableCell>
                ))}
                <TableCell className="text-right">
                  <Money cents={total.dueCents} />
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={total.coveredCents} />
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={uncoveredCents} />
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Where it comes from</CardTitle>
            <CardDescription>
              Recorded statements are firm. Estimated cycles repeat the card&apos;s current
              unbilled balance each cycle — a run rate, not compounding debt. Promo &amp; spend
              covers 0% payoff chunks and forecast card spend.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Card</TableHead>
                <TableHead className="text-right">Statements</TableHead>
                <TableHead className="text-right">Estimated cycles</TableHead>
                <TableHead className="text-right">Promo &amp; spend</TableHead>
                <TableHead className="text-right">Total due</TableHead>
                <TableHead className="text-right">Cash out</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cards.map((c) => (
                <TableRow key={c.cardId}>
                  <TableCell className="font-medium text-[var(--text-0)]">
                    <Link
                      href={`/credit-cards/${c.cardId}`}
                      className="inline-flex items-center gap-1.5 hover:text-[var(--mint)]"
                    >
                      <span
                        aria-hidden
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ background: colorByCardId.get(c.cardId) }}
                      />
                      {c.cardName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">
                    {c.statementDueCents > 0 ? (
                      <Money cents={c.statementDueCents} />
                    ) : (
                      <span className="text-[var(--text-3)]">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {c.estimatedDueCents > 0 ? (
                      <Money cents={c.estimatedDueCents} />
                    ) : (
                      <span className="text-[var(--text-3)]">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {c.promoDueCents > 0 ? (
                      <Money cents={c.promoDueCents} />
                    ) : (
                      <span className="text-[var(--text-3)]">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-semibold text-[var(--text-0)]">
                    <Money cents={c.dueCents} />
                  </TableCell>
                  <TableCell className="text-right text-[var(--text-2)]">
                    {c.cashOutCents > 0 ? (
                      <Money cents={c.cashOutCents} />
                    ) : (
                      <span className="text-[var(--text-3)]">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell>Total</TableCell>
                <TableCell className="text-right">
                  <Money cents={total.statementDueCents} />
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={total.estimatedDueCents} />
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={total.promoDueCents} />
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={total.dueCents} />
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={total.cashOutCents} />
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>

      <p className="text-[12px] leading-relaxed text-[var(--text-3)]">
        Cash out is what actually leaves checking for cards — planned payments, promo chunks, and
        forecast card spend. A due date on its own never debits the projection; only payments you
        schedule do.
      </p>
    </div>
  );
}
