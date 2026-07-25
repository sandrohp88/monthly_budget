"use client";

// Wallet-style credit cards overview. Each card shows its face (official
// issuer art where available), current balance, and last digits — everything
// else lives on the per-card detail page (/credit-cards/[id]).

import * as React from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHead } from "@/components/ui/page-head";
import { Tile, TileGrid } from "@/components/ui/tile";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import { CreditCardVisual } from "@/components/credit-card-visual";
import { InlineBalanceEditor } from "@/components/inline-balance-editor";
import { Skeleton } from "@/components/ui/skeleton";
import { cardDisplayName, cardMaskDigits } from "@/lib/card-art";
import { daysBetween } from "@/lib/credit-cards";
import { todayIso } from "@/lib/dates";
import { cn } from "@/lib/cn";
import type { CreditCardRow } from "@/lib/db/schema";
import type { CardForecast } from "@/lib/card-forecast";
import type { CardSpendingSummary } from "@/lib/card-spending";
import { CardDialog } from "./card-dialogs";
import { CardSpendingView } from "./spending-client";

// The forecast pulls in Recharts — keep it out of the wallet's first load.
const CardForecastView = dynamic(
  () => import("./forecast-client").then((m) => m.CardForecastView),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[320px] w-full" />,
  },
);

export type WalletCard = {
  card: CreditCardRow;
  /** Last digits from the linked Plaid account (falls back to the name). */
  mask: string | null;
  /** Institution of the linked Plaid account, e.g. "Chase". */
  institution: string | null;
  /** Best-known card balance (synced, live, or known obligations). */
  balanceCents: number | null;
  /** Cash due on the current open statement (0 when none). */
  dueCents: number;
  /** Due date of the current open statement. */
  dueDate: string | null;
};

type Tab = "wallet" | "spending" | "forecast";

export function CreditCardsClient({
  initialCards,
  timezone,
  forecast,
  spending,
}: {
  initialCards: WalletCard[];
  timezone: string;
  /** Null when the user has no settings row yet (pre-setup). */
  forecast: CardForecast | null;
  /** Current-cycle charges + utilization, from posted transactions. */
  spending: CardSpendingSummary;
}) {
  const cards = initialCards;
  const [addOpen, setAddOpen] = React.useState(false);
  const [tab, setTab] = React.useState<Tab>("wallet");
  const today = todayIso(timezone);

  const refresh = () => {
    // Balances and due states are computed server-side — reload to recompute.
    window.location.reload();
  };

  const known = cards.filter((c) => c.balanceCents != null);
  const totalBalanceCents = known.reduce((s, c) => s + (c.balanceCents ?? 0), 0);
  const due = cards.filter((c) => c.dueCents > 0 && c.dueDate != null);
  const totalDueCents = due.reduce((s, c) => s + c.dueCents, 0);
  const nextDue = [...due].sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))[0];
  const overdueCount = due.filter((c) => c.dueDate! < today).length;

  // Spending needs no projection, so the tab bar shows as soon as there's a
  // card; only the forecast tab depends on a settings row existing.
  const showTabs = cards.length > 0;
  const tabButton = (id: Tab, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      className={cn(
        "cursor-pointer rounded-full border px-4 py-1.5 text-[12px] font-semibold transition-colors",
        tab === id
          ? "border-[var(--mint)] bg-[var(--mint-glow)] text-[var(--mint)]"
          : "border-[var(--border-raw)] text-[var(--text-2)] hover:border-[var(--border-2)] hover:text-[var(--text-0)]",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-6 fade-in">
      <PageHead
        title="Credit cards"
        subtitle="Tap a card for statements, promos, and payment planning"
        actions={
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            <Plus className="h-3 w-3" /> Add card
          </Button>
        }
      />

      {showTabs ? (
        <div className="flex items-center gap-2">
          {tabButton("wallet", "Wallet")}
          {tabButton("spending", "Spending")}
          {forecast != null ? tabButton("forecast", "Forecast") : null}
        </div>
      ) : null}

      {showTabs && tab === "spending" ? <CardSpendingView spending={spending} /> : null}
      {showTabs && tab === "forecast" && forecast != null ? (
        <CardForecastView forecast={forecast} />
      ) : null}

      {tab === "wallet" && cards.length > 0 ? (
        <TileGrid cols="auto">
          <Tile
            compact
            label="Total balance"
            value={<Money cents={totalBalanceCents} />}
            delta={`across ${known.length} card${known.length === 1 ? "" : "s"}`}
          />
          <Tile
            compact
            label="Due now"
            value={
              totalDueCents > 0 ? (
                <Money cents={totalDueCents} />
              ) : (
                <span className="text-[var(--text-2)]">—</span>
              )
            }
            variant={overdueCount > 0 ? "red" : totalDueCents > 0 ? "amber" : "mint"}
            delta={
              overdueCount > 0
                ? `${overdueCount} overdue statement${overdueCount === 1 ? "" : "s"}`
                : totalDueCents > 0
                  ? `${due.length} unpaid statement${due.length === 1 ? "" : "s"}`
                  : "all statements paid"
            }
          />
          <Tile
            compact
            label="Next payment"
            value={
              nextDue ? (
                <Money cents={nextDue.dueCents} />
              ) : (
                <span className="text-[var(--text-2)]">—</span>
              )
            }
            variant={nextDue && nextDue.dueDate! < today ? "red" : "default"}
            delta={
              nextDue ? (
                <>
                  {cardDisplayName(nextDue.card.name, nextDue.institution)} ·{" "}
                  <DateLabel iso={nextDue.dueDate!} format="short" />
                </>
              ) : (
                "nothing scheduled"
              )
            }
          />
        </TileGrid>
      ) : null}

      {tab !== "wallet" ? null : cards.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border-2)] bg-[var(--bg-card)] px-6 py-14 text-center">
          <p className="mb-4 text-[13px] text-[var(--text-2)]">
            Add a credit card to start tracking statement balances and due dates.
          </p>
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            <Plus className="h-3 w-3" /> Add your first card
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {cards.map((wc) => (
            <WalletCardEntry key={wc.card.id} data={wc} today={today} />
          ))}
        </div>
      )}

      {addOpen ? (
        <CardDialog timezone={timezone} onClose={() => setAddOpen(false)} onSaved={refresh} />
      ) : null}
    </div>
  );
}

function WalletCardEntry({ data, today }: { data: WalletCard; today: string }) {
  const { card, mask, institution, balanceCents, dueCents, dueDate } = data;
  const name = cardDisplayName(card.name, institution);
  const digits = cardMaskDigits(card.name, mask);

  const daysLeft = dueCents > 0 && dueDate ? daysBetween(today, dueDate) : null;
  const status: "overdue" | "due-soon" | null =
    daysLeft == null ? null : daysLeft < 0 ? "overdue" : daysLeft <= 7 ? "due-soon" : null;

  return (
    <Link
      href={`/credit-cards/${card.id}`}
      className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mint-dim)]"
    >
      <CreditCardVisual
        name={card.name}
        institution={institution}
        mask={mask}
        className="shadow-[var(--shadow-sm)] transition-all duration-200 group-hover:-translate-y-1 group-hover:shadow-[var(--shadow-md)]"
      >
        {status ? (
          <span
            className={cn(
              "absolute right-2.5 top-2.5 rounded-full px-2 py-0.5 text-2xs font-bold tracking-wide text-white shadow-sm",
              status === "overdue" ? "bg-[#d13f3f]" : "bg-[#c97a10]",
            )}
          >
            {status === "overdue" ? "Overdue" : `Due in ${daysLeft}D`}
          </span>
        ) : null}
      </CreditCardVisual>
      <div className="mt-2.5 flex items-start justify-between gap-2 px-0.5">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold leading-snug text-[var(--text-0)] sm:text-[13px]">
            {name}
          </div>
          <div className="mt-0.5 text-[11px] text-[var(--text-3)] tabular sm:text-[12px]">
            {digits ? `•••• ${digits}` : "manual card"}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[14px] font-bold leading-snug tracking-tight tabular text-[var(--text-0)] sm:text-[15px]">
            {card.plaidAccountId == null ? (
              <InlineBalanceEditor cardId={card.id} valueCents={balanceCents} />
            ) : balanceCents != null ? (
              <Money cents={balanceCents} />
            ) : (
              <span className="font-medium text-[var(--text-3)]">—</span>
            )}
          </div>
          <div className="text-2xs leading-tight text-[var(--text-3)] sm:text-[11px]">balance</div>
        </div>
      </div>
    </Link>
  );
}
