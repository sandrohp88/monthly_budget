"use client";

// What has actually hit each card since its last statement closed (from posted
// transactions), and how full each card is against its credit line.

import * as React from "react";
import Link from "next/link";
import { ChevronDown, CreditCard as CreditCardIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tile, TileGrid } from "@/components/ui/tile";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusPill } from "@/components/ui/status-pill";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import { cn } from "@/lib/cn";
import { formatCategoryLabel } from "@/lib/card-spending";
import type { CardSpending, CardSpendingSummary, UtilizationBand } from "@/lib/card-spending";

const BAND_LABEL: Record<UtilizationBand, string> = {
  low: "Comfortable",
  moderate: "Moderate",
  high: "Running high",
  maxed: "Nearly maxed",
};

const BAND_BAR: Record<UtilizationBand, string> = {
  low: "bg-[var(--phosphor)]",
  moderate: "bg-[var(--cyan)]",
  high: "bg-[var(--amber)]",
  maxed: "bg-[var(--red)]",
};

const BAND_TEXT: Record<UtilizationBand, string> = {
  low: "text-[var(--phosphor)]",
  moderate: "text-[var(--text-0)]",
  high: "text-[var(--amber)]",
  maxed: "text-[var(--red)]",
};

const BAND_PILL: Record<UtilizationBand, "default" | "warn" | "danger"> = {
  low: "default",
  moderate: "default",
  high: "warn",
  maxed: "danger",
};

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(ratio >= 0.1 ? 0 : 1)}%`;
}

export function CardSpendingView({ spending }: { spending: CardSpendingSummary }) {
  const { cards, crowded, overallUtilization, cardsWithoutLimit } = spending;

  if (cards.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<CreditCardIcon className="h-5 w-5" />}
          title="No cards to track"
          description="Add a card — link it to a bank account and its charges show up here as they post."
        />
      </Card>
    );
  }

  const linkedCount = cards.filter((c) => c.transactionCount > 0).length;

  return (
    <div className="space-y-5">
      <TileGrid cols="auto">
        <Tile
          compact
          label="Charged this cycle"
          value={<Money cents={spending.totalCycleSpendCents} />}
          delta={
            linkedCount > 0
              ? `posted charges across ${linkedCount} card${linkedCount === 1 ? "" : "s"}`
              : "no posted charges yet this cycle"
          }
        />
        <Tile
          compact
          label="Total balance"
          value={<Money cents={spending.totalBalanceCents} />}
          delta="what the issuers say you owe now"
        />
        <Tile
          compact
          label="Overall utilization"
          value={
            overallUtilization != null ? (
              pct(overallUtilization)
            ) : (
              <span className="text-[var(--text-2)]">—</span>
            )
          }
          variant={
            overallUtilization == null
              ? "default"
              : overallUtilization >= 0.7
                ? "red"
                : overallUtilization >= 0.3
                  ? "amber"
                  : "mint"
          }
          delta={
            overallUtilization != null ? (
              <>
                of <Money cents={spending.totalLimitCents} /> in credit lines
                {cardsWithoutLimit > 0 ? ` · ${cardsWithoutLimit} card without a limit set` : ""}
              </>
            ) : (
              "set a credit limit on a card to see this"
            )
          }
        />
        <Tile
          compact
          label="Running high"
          value={crowded.length > 0 ? String(crowded.length) : "0"}
          variant={crowded.length > 0 ? "amber" : "mint"}
          delta={
            crowded.length > 0
              ? crowded.map((c) => c.cardName).join(", ")
              : "every card under 70% of its line"
          }
        />
      </TileGrid>

      <div className="space-y-3">
        {cards.map((c) => (
          <CardSpendingRow key={c.cardId} card={c} />
        ))}
      </div>

      <p className="text-[12px] leading-relaxed text-[var(--text-3)]">
        Cycle spend counts posted charges between the last statement close and today — that&apos;s
        what the next statement is shaping up to be. It is not the balance, which also carries
        anything unpaid from earlier cycles. Utilization uses the balance, since that&apos;s what
        the issuer reports. Pending charges appear once they post.
      </p>
    </div>
  );
}

function CardSpendingRow({ card: c }: { card: CardSpending }) {
  const [open, setOpen] = React.useState(false);
  const hasDetail = c.topTransactions.length > 0 || c.byCategory.length > 0;

  return (
    <Card>
      <CardHeader className="flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <CardTitle className="truncate">
            <Link href={`/credit-cards/${c.cardId}`} className="hover:text-[var(--mint)]">
              {c.cardName}
            </Link>
          </CardTitle>
          <CardDescription>
            Cycle <DateLabel iso={c.window.start} format="short" /> –{" "}
            <DateLabel iso={c.window.end} format="short" /> ·{" "}
            {c.daysToClose === 0 ? "closes today" : `closes in ${c.daysToClose}d`}
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-5">
          <div className="text-right">
            <div className="text-[20px] font-bold leading-none tabular text-[var(--text-0)]">
              <Money cents={c.cycleSpendCents} />
            </div>
            <div className="mt-1 text-2xs text-[var(--text-3)]">
              {c.transactionCount === 0
                ? "nothing posted yet"
                : `${c.transactionCount} charge${c.transactionCount === 1 ? "" : "s"} this cycle`}
            </div>
          </div>
          {c.band ? <StatusPill variant={BAND_PILL[c.band]}>{BAND_LABEL[c.band]}</StatusPill> : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-4 pt-4">
        {/* Utilization bar — the "is this card too full" read. */}
        {c.utilization != null && c.band ? (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between text-[12px]">
              <span className={cn("font-semibold tabular", BAND_TEXT[c.band])}>
                {pct(c.utilization)} used
              </span>
              <span className="text-[var(--text-2)] tabular">
                <Money cents={c.balanceCents ?? 0} /> of{" "}
                <Money cents={c.creditLimitCents ?? 0} />
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--bg-3)]">
              <div
                className={cn("h-full rounded-full transition-all", BAND_BAR[c.band])}
                style={{ width: `${Math.min(100, Math.max(2, c.utilization * 100))}%` }}
              />
            </div>
            <div className="text-2xs text-[var(--text-3)]">
              {c.headroomCents != null && c.headroomCents >= 0 ? (
                <>
                  <Money cents={c.headroomCents} /> left before the limit
                </>
              ) : (
                <span className="text-[var(--red)]">
                  <Money cents={Math.abs(c.headroomCents ?? 0)} /> over the limit
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-[var(--border-raw)] px-3 py-2 text-2xs text-[var(--text-3)]">
            No credit limit set for this card — add one in the card&apos;s edit dialog to see how
            full it is. A linked card fills this in from the issuer on the next sync.
          </div>
        )}

        {/* Pace: only meaningful once something has actually posted. */}
        {c.transactionCount > 0 ? (
          <div className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-3">
            <Stat label="Per day so far" value={<Money cents={c.dailyPaceCents} />} />
            <Stat
              label="On pace for"
              value={<Money cents={c.projectedCycleSpendCents} />}
              hint="at this rate, by close"
            />
            <Stat
              label="Biggest charge"
              value={<Money cents={c.topTransactions[0]?.amountCents ?? 0} />}
              hint={c.topTransactions[0]?.merchantName ?? c.topTransactions[0]?.description}
            />
          </div>
        ) : null}

        {hasDetail ? (
          <div>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="flex cursor-pointer items-center gap-1.5 text-[12px] font-semibold text-[var(--text-2)] transition-colors hover:text-[var(--text-0)]"
            >
              <ChevronDown
                className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
              />
              {open ? "Hide charges" : "Show charges"}
            </button>

            {open ? (
              <div className="mt-3 grid gap-5 lg:grid-cols-2">
                <div>
                  <div className="mb-2 text-2xs font-semibold text-[var(--text-3)]">
                    Biggest charges
                  </div>
                  <table className="w-full text-[12px] tabular">
                    <tbody>
                      {c.topTransactions.map((t) => (
                        <tr
                          key={t.id}
                          className="border-b border-[var(--border-raw)] last:border-0"
                        >
                          <td className="py-1.5 pr-2 whitespace-nowrap text-[var(--text-3)]">
                            <DateLabel iso={t.date} format="short" />
                          </td>
                          <td className="max-w-[220px] truncate py-1.5 pr-2 text-[var(--text-1)]">
                            {t.merchantName ?? t.description}
                          </td>
                          <td className="py-1.5 text-right text-[var(--text-0)]">
                            <Money cents={t.amountCents} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <div className="mb-2 text-2xs font-semibold text-[var(--text-3)]">
                    By category
                  </div>
                  <table className="w-full text-[12px] tabular">
                    <tbody>
                      {c.byCategory.slice(0, 8).map((row) => (
                        <tr
                          key={row.category}
                          className="border-b border-[var(--border-raw)] last:border-0"
                        >
                          <td className="max-w-[220px] truncate py-1.5 pr-2 text-[var(--text-1)]">
                            {formatCategoryLabel(row.category)}
                          </td>
                          <td className="py-1.5 pr-2 text-right text-[var(--text-3)]">
                            {row.count}
                          </td>
                          <td className="py-1.5 text-right text-[var(--text-0)]">
                            <Money cents={row.amountCents} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string | null;
}) {
  return (
    <div>
      <div className="text-2xs text-[var(--text-3)]">{label}</div>
      <div className="mt-0.5 font-semibold tabular text-[var(--text-0)]">{value}</div>
      {hint ? <div className="truncate text-2xs text-[var(--text-3)]">{hint}</div> : null}
    </div>
  );
}
