"use client";

import * as React from "react";
import {
  Plus,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  FileText,
  Sparkles,
  Scale,
  CalendarDays,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { CardSubTag, PageHead } from "@/components/ui/page-head";
import { Tile, TileGrid } from "@/components/ui/tile";
import { StatusPill } from "@/components/ui/status-pill";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MoneyInput } from "@/components/money-input";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import { PayPalPromoReconcileDialog } from "@/components/paypal-promo-reconcile-dialog";
import {
  CardWithStatements,
  LinkedBillEstimate,
  cardPromoWhatIf,
  currentStatementOf,
  daysBetween,
  dueDateFromStatement,
  isStatementOpen,
  nextStatementDateOnOrAfter,
  paidWithoutInterest,
  previousStatementDateOnOrBefore,
  promoMonthlyChunkAt,
  promoWhatIf,
  statementCashDueCents,
  summarizeStatementBalances,
  totalDue,
} from "@/lib/credit-cards";
import { todayIso } from "@/lib/dates";
import { cn } from "@/lib/cn";
import type {
  CreditCardPromoRow,
  CreditCardRow,
  CreditCardStatementRow,
} from "@/lib/db/schema";

type StatementWithCard = CreditCardStatementRow & { cardName: string; cardId: string };
export type PromoScheduledPayment = {
  id: string;
  dueDate: string;
  amountCents: number;
  note: string | null;
};
type StatementCycleMode = "calendar_day" | "interval_days";

export type CycleEstimate = {
  window: { start: string; end: string };
  charges: LinkedBillEstimate[];
  totalCents: number;
};
export type CardWithStatementsAndEstimate = CardWithStatements & {
  estimate: CycleEstimate | null;
  linkedBillCount: number;
  promos: CreditCardPromoRow[];
};

function statementCycleLabel(card: CreditCardRow): string {
  if (card.statementCycleMode === "interval_days") {
    return `${card.statementCycleIntervalDays}D CYCLE`;
  }
  return `STATEMENT D${card.statementDay}`;
}

export function CreditCardsClient({
  initialCards,
  initialPaymentsByPromoId,
}: {
  initialCards: CardWithStatementsAndEstimate[];
  initialPaymentsByPromoId: Record<string, PromoScheduledPayment[]>;
}) {
  // No setter — the refresh handler does a full reload so the server can
  // recompute the cycle estimate from fresh bills + statements together.
  const cards = initialCards;
  const paymentsByPromoId = initialPaymentsByPromoId;
  const [createCardOpen, setCreateCardOpen] = React.useState(false);
  const [editCard, setEditCard] = React.useState<CreditCardRow | null>(null);
  const [statementCard, setStatementCard] = React.useState<CreditCardRow | null>(null);
  const [editStatement, setEditStatement] = React.useState<{ cardId: string; statement: CreditCardStatementRow } | null>(null);
  const [createPromoCard, setCreatePromoCard] = React.useState<CreditCardRow | null>(null);
  const [editPromo, setEditPromo] = React.useState<{ card: CreditCardRow; promo: CreditCardPromoRow } | null>(null);
  const [whatIfPromo, setWhatIfPromo] = React.useState<{ card: CreditCardRow; promo: CreditCardPromoRow } | null>(null);
  const [whatIfCard, setWhatIfCard] = React.useState<{ card: CreditCardRow; promos: CreditCardPromoRow[] } | null>(null);
  const [schedulePromo, setSchedulePromo] = React.useState<{ card: CreditCardRow; promo: CreditCardPromoRow } | null>(null);
  const [reconcileCard, setReconcileCard] = React.useState<{ card: CreditCardRow; promos: CreditCardPromoRow[] } | null>(null);

  const today = todayIso();

  // ── derived ─────────────────────────────────────────────────────────────
  const activeCards = cards.filter((c) => c.card.isActive);
  const allOpenStatements: StatementWithCard[] = cards.flatMap((c) =>
    c.statements
      .filter(isStatementOpen)
      .map((s) => ({ ...s, cardName: c.card.name, cardId: c.card.id })),
  );
  const totalDueCents = totalDue(allOpenStatements);
  const nextDue = [...allOpenStatements].sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  const overdue = allOpenStatements.filter((s) => s.dueDate < today);

  // Sum of expected cycle charges across all active cards
  const totalExpectedThisCycle = cards
    .filter((c) => c.card.isActive)
    .reduce((sum, c) => sum + (c.estimate?.totalCents ?? 0), 0);
  const totalLinkedCardItems = cards
    .filter((c) => c.card.isActive)
    .reduce((sum, c) => sum + c.linkedBillCount, 0);

  // Promo aggregates across all active cards
  const allActivePromos = cards
    .filter((c) => c.card.isActive)
    .flatMap((c) => c.promos.filter((p) => p.isActive && p.remainingAmountCents > 0));
  const totalPromoRemainingCents = allActivePromos.reduce(
    (s, p) => s + p.remainingAmountCents,
    0,
  );
  const nextPromoDeadline = [...allActivePromos].sort((a, b) =>
    a.endDate.localeCompare(b.endDate),
  )[0];

  // ── refresh after writes ────────────────────────────────────────────────
  const refresh = async () => {
    // Server-side estimate isn't recomputed by the cards API alone, so the
    // simplest correct refresh after a card/statement edit is a full reload.
    // (The card API doesn't know about bills.)
    window.location.reload();
  };

  // ── card CRUD handlers ──────────────────────────────────────────────────
  const archiveCard = async (id: string) => {
    if (!confirm("Archive this card? Statement history is kept.")) return;
    const res = await fetch(`/api/credit-cards/${id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Archive failed");
      return;
    }
    toast.success("Card archived");
    await refresh();
  };

  return (
    <div className="space-y-6 fade-in">
      <PageHead
        module="MODULE_07"
        title="CREDIT CARDS"
        subtitle="Track statements and pay before due date to avoid interest"
        actions={
          <Button variant="primary" onClick={() => setCreateCardOpen(true)}>
            <Plus className="h-3 w-3" /> ADD CARD
          </Button>
        }
      />

      <TileGrid cols="auto">
        <Tile
          label="ACTIVE CARDS"
          value={activeCards.length}
          delta={cards.length > activeCards.length ? `${cards.length - activeCards.length} archived` : "all active"}
        />
        <Tile
          label="CURRENTLY DUE"
          value={<Money cents={totalDueCents} />}
          variant={totalDueCents > 0 ? (overdue.length > 0 ? "red" : "amber") : "mint"}
          delta={`${allOpenStatements.length} unpaid statement${allOpenStatements.length === 1 ? "" : "s"}`}
          badge={overdue.length > 0 ? <Badge variant="destructive">OVERDUE</Badge> : undefined}
        />
        <Tile
          label="EXPECTED THIS CYCLE"
          value={
            totalExpectedThisCycle > 0 ? (
              <Money cents={totalExpectedThisCycle} />
            ) : (
              <span className="text-[var(--text-2)] text-base">—</span>
            )
          }
          delta={
            totalLinkedCardItems > 0
              ? `${totalLinkedCardItems} linked item${totalLinkedCardItems === 1 ? "" : "s"}`
              : "no linked card spend yet"
          }
        />
        <Tile
          label="NEXT PAYMENT"
          value={
            nextDue ? (
              <Money cents={statementCashDueCents(nextDue)} />
            ) : (
              <span className="text-[var(--text-2)] text-base">—</span>
            )
          }
          delta={
            nextDue ? (
              <>
                {nextDue.cardName} · <DateLabel iso={nextDue.dueDate} format="short" />
              </>
            ) : (
              "all paid"
            )
          }
          variant={nextDue ? (nextDue.dueDate < today ? "red" : "mint") : "default"}
        />
        <Tile
          label="OVERDUE"
          value={overdue.length}
          variant={overdue.length > 0 ? "red" : "default"}
          delta={overdue.length > 0 ? "INTEREST ACCRUING" : "none"}
        />
        <Tile
          label="PROMO BALANCE"
          value={
            totalPromoRemainingCents > 0 ? (
              <Money cents={totalPromoRemainingCents} />
            ) : (
              <span className="text-[var(--text-2)] text-base">—</span>
            )
          }
          delta={
            allActivePromos.length > 0 ? (
              <>
                {allActivePromos.length} ACTIVE
                {nextPromoDeadline ? (
                  <>
                    {" · NEXT END "}
                    <DateLabel iso={nextPromoDeadline.endDate} format="short" />
                  </>
                ) : null}
              </>
            ) : (
              "no deferred-interest promos"
            )
          }
          variant={totalPromoRemainingCents > 0 ? "mint" : "default"}
        />
      </TileGrid>

      {activeCards.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>NO CARDS YET</CardTitle>
          </CardHeader>
          <div className="px-4 py-8 text-center">
            <p className="mb-4 text-[11px] tracking-wide text-[var(--text-2)]">
              Add a credit card to start tracking statement balances and due dates.
            </p>
            <Button variant="primary" onClick={() => setCreateCardOpen(true)}>
              <Plus className="h-3 w-3" /> ADD YOUR FIRST CARD
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {activeCards.map(({ card, statements, estimate, linkedBillCount, promos }) => (
            <CreditCardTile
              key={card.id}
              card={card}
              statements={statements}
              estimate={estimate}
              linkedBillCount={linkedBillCount}
              promos={promos}
              paymentsByPromoId={paymentsByPromoId}
              today={today}
              onAddStatement={() => setStatementCard(card)}
              onEdit={() => setEditCard(card)}
              onArchive={() => archiveCard(card.id)}
              onEditStatement={(s) => setEditStatement({ cardId: card.id, statement: s })}
              onAddPromo={() => setCreatePromoCard(card)}
              onEditPromo={(p) => setEditPromo({ card, promo: p })}
              onPromoWhatIf={(p) => setWhatIfPromo({ card, promo: p })}
              onCardPromoWhatIf={() =>
                setWhatIfCard({ card, promos: promos.filter((p) => p.isActive) })
              }
              onPromoSchedule={(p) => setSchedulePromo({ card, promo: p })}
              onReconcilePromos={() => setReconcileCard({ card, promos })}
            />
          ))}
        </div>
      )}

      {/* Card create/edit dialog */}
      {createCardOpen ? (
        <CardDialog
          onClose={() => setCreateCardOpen(false)}
          onSaved={async () => {
            setCreateCardOpen(false);
            await refresh();
          }}
        />
      ) : null}
      {editCard ? (
        <CardDialog
          card={editCard}
          onClose={() => setEditCard(null)}
          onSaved={async () => {
            setEditCard(null);
            await refresh();
          }}
        />
      ) : null}

      {/* Add statement dialog */}
      {statementCard ? (
        <StatementCreateDialog
          card={statementCard}
          existingStatements={
            cards.find((c) => c.card.id === statementCard.id)?.statements ?? []
          }
          onClose={() => setStatementCard(null)}
          onSaved={async () => {
            setStatementCard(null);
            await refresh();
          }}
        />
      ) : null}

      {/* Edit/mark-paid statement dialog */}
      {editStatement ? (
        <StatementEditDialog
          statement={editStatement.statement}
          onClose={() => setEditStatement(null)}
          onSaved={async () => {
            setEditStatement(null);
            await refresh();
          }}
        />
      ) : null}

      {/* Promo create dialog */}
      {createPromoCard ? (
        <PromoDialog
          card={createPromoCard}
          onClose={() => setCreatePromoCard(null)}
          onSaved={async () => {
            setCreatePromoCard(null);
            await refresh();
          }}
        />
      ) : null}

      {/* Promo edit dialog */}
      {editPromo ? (
        <PromoDialog
          card={editPromo.card}
          promo={editPromo.promo}
          onClose={() => setEditPromo(null)}
          onSaved={async () => {
            setEditPromo(null);
            await refresh();
          }}
        />
      ) : null}

      {/* Per-promo what-if sheet */}
      {whatIfPromo ? (
        <PromoWhatIfSheet
          scope="promo"
          card={whatIfPromo.card}
          promos={[whatIfPromo.promo]}
          paymentsByPromoId={paymentsByPromoId}
          onClose={() => setWhatIfPromo(null)}
        />
      ) : null}

      {/* Per-card rollup what-if sheet */}
      {whatIfCard ? (
        <PromoWhatIfSheet
          scope="card"
          card={whatIfCard.card}
          promos={whatIfCard.promos}
          paymentsByPromoId={paymentsByPromoId}
          onClose={() => setWhatIfCard(null)}
        />
      ) : null}

      {/* Promo payment-schedule editor */}
      {schedulePromo ? (
        <PromoScheduleSheet
          card={schedulePromo.card}
          promo={schedulePromo.promo}
          initialPayments={paymentsByPromoId[schedulePromo.promo.id] ?? []}
          onClose={() => setSchedulePromo(null)}
          onSaved={async () => {
            setSchedulePromo(null);
            await refresh();
          }}
        />
      ) : null}

      {/* Reconcile promos from a pasted PayPal promo list */}
      {reconcileCard ? (
        <PayPalPromoReconcileDialog
          card={{ id: reconcileCard.card.id, name: reconcileCard.card.name }}
          promos={reconcileCard.promos}
          onClose={() => setReconcileCard(null)}
          onApplied={async () => {
            setReconcileCard(null);
            await refresh();
          }}
        />
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Single card tile
// ─────────────────────────────────────────────────────────────────────────────

function CreditCardTile({
  card,
  statements,
  estimate,
  linkedBillCount,
  promos,
  paymentsByPromoId,
  today,
  onAddStatement,
  onEdit,
  onArchive,
  onEditStatement,
  onAddPromo,
  onEditPromo,
  onPromoWhatIf,
  onCardPromoWhatIf,
  onPromoSchedule,
  onReconcilePromos,
}: {
  card: CreditCardRow;
  statements: CreditCardStatementRow[];
  estimate: CycleEstimate | null;
  linkedBillCount: number;
  promos: CreditCardPromoRow[];
  paymentsByPromoId: Record<string, PromoScheduledPayment[]>;
  today: string;
  onAddStatement: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onEditStatement: (s: CreditCardStatementRow) => void;
  onAddPromo: () => void;
  onEditPromo: (p: CreditCardPromoRow) => void;
  onPromoWhatIf: (p: CreditCardPromoRow) => void;
  onCardPromoWhatIf: () => void;
  onPromoSchedule: (p: CreditCardPromoRow) => void;
  onReconcilePromos: () => void;
}) {
  const current = currentStatementOf(statements);
  const isOpen = current ? isStatementOpen(current) : false;
  const days = current ? daysBetween(today, current.dueDate) : null;
  const safe = current ? paidWithoutInterest(current) : false;

  // status: paid_safe | paid_late | unpaid_far | unpaid_close | overdue | none
  const status: "paid_safe" | "paid_late" | "unpaid_far" | "unpaid_close" | "overdue" | "none" =
    current == null
      ? "none"
      : !isOpen
        ? safe
          ? "paid_safe"
          : "paid_late"
        : days == null
          ? "none"
          : days < 0
            ? "overdue"
            : days <= 7
              ? "unpaid_close"
              : "unpaid_far";

  const ringColor = {
    paid_safe: "var(--mint-dim)",
    paid_late: "rgba(251,191,36,0.4)",
    unpaid_far: "var(--border-2)",
    unpaid_close: "rgba(251,191,36,0.45)",
    overdue: "rgba(239,68,68,0.55)",
    none: "var(--border-raw)",
  }[status];

  return (
    <div
      className="relative overflow-hidden rounded-sm border bg-[var(--bg-card)] p-4 transition-colors"
      style={{ borderColor: ringColor }}
    >
      <span className="absolute right-2 top-2 h-2 w-2 border-r border-t border-[var(--mint-dim)]" />
      <span className="absolute bottom-2 left-2 h-2 w-2 border-b border-l border-[var(--mint-dim)]" />

      {/* header */}
      <div className="mb-3 flex items-start justify-between">
        <div>
          <div className="text-[9px] uppercase tracking-[0.2em] text-[var(--text-3)]">
            {`// CARD`}
          </div>
          <div className="text-[14px] font-bold uppercase tracking-[0.1em] text-[var(--text-0)]">
            {card.name}
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-[var(--text-2)]">
            {statementCycleLabel(card)} · DUE D{card.dueDay}
            {card.autoPay ? " · AUTOPAY" : ""}
          </div>
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit} aria-label="Edit card">
            EDIT
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onArchive}
            aria-label="Archive card"
            title="Archive"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {card.currentBalanceCents != null ? (
        <div className="mb-3 flex items-center justify-between rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 py-2">
          <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--text-3)]">
            CURRENT BALANCE
          </span>
          <span className="text-[14px] font-bold tabular text-[var(--text-0)]">
            <Money cents={card.currentBalanceCents} />
          </span>
        </div>
      ) : null}

      {/* current statement state */}
      <div className="my-4 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-1)] p-3">
        {current == null ? (
          <div className="text-center">
            <div className="mb-1 text-[9px] uppercase tracking-[0.2em] text-[var(--text-3)]">
              {`// NO STATEMENT`}
            </div>
            <div className="mb-2 text-[11px] tracking-wide text-[var(--text-2)]">
              Next statement expected{" "}
              <span className="text-[var(--text-0)]">
                <DateLabel iso={nextStatementDateOnOrAfter(today, card)} format="short" />
              </span>
            </div>
            <Button size="sm" variant="primary" onClick={onAddStatement}>
              <FileText className="h-3 w-3" /> ENTER STATEMENT
            </Button>
          </div>
        ) : (
          <>
            <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-[0.18em] text-[var(--text-3)]">
              <span>
                {isOpen ? "DUE TO AVOID INTEREST" : "LAST PAID"}
              </span>
              {isOpen ? (
                status === "overdue" ? (
                  <StatusPill variant="danger">{`${Math.abs(days!)}D OVERDUE`}</StatusPill>
                ) : status === "unpaid_close" ? (
                  <StatusPill variant="warn">{`DUE IN ${days}D`}</StatusPill>
                ) : (
                  <StatusPill>{`DUE IN ${days}D`}</StatusPill>
                )
              ) : safe ? (
                <StatusPill>
                  <CheckCircle2 className="mr-1 inline h-3 w-3 -mt-px" />
                  ON TIME
                </StatusPill>
              ) : (
                <StatusPill variant="warn">PAID LATE</StatusPill>
              )}
            </div>
            <div
              className={cn(
                "mb-1 text-[26px] font-bold leading-none tracking-tight tabular",
                isOpen
                  ? status === "overdue"
                    ? "text-[var(--red)]"
                    : status === "unpaid_close"
                      ? "text-[var(--amber)]"
                      : "text-[var(--text-0)]"
                  : safe
                    ? "text-[var(--mint)]"
                    : "text-[var(--amber)]",
              )}
            >
              <Money cents={statementCashDueCents(current)} />
            </div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-2)]">
              CLOSED <DateLabel iso={current.statementDate} format="short" /> · DUE{" "}
              <span className="text-[var(--text-0)]">
                <DateLabel iso={current.dueDate} format="short" />
              </span>
              {!isOpen && current.paidDate ? (
                <>
                  {" · PAID "}
                  <span className={safe ? "text-[var(--mint)]" : "text-[var(--amber)]"}>
                    <DateLabel iso={current.paidDate} format="short" />
                  </span>
                </>
              ) : null}
            </div>

            {isOpen ? (
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => onEditStatement(current)}
                  className="flex-1"
                >
                  MARK PAID
                </Button>
                <Button size="sm" variant="outline" onClick={onAddStatement}>
                  NEW STATEMENT
                </Button>
              </div>
            ) : (
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="primary" onClick={onAddStatement} className="flex-1">
                  <FileText className="h-3 w-3" /> ENTER NEW STATEMENT
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* linked-card statement history snapshot (Plaid-linked cards only) */}
      {card.plaidAccountId ? (
        <LinkedStatementSummary statements={statements} today={today} />
      ) : null}

      {/* expected charges this cycle (from linked bills and one-time purchases) */}
      {linkedBillCount > 0 && estimate ? (
        <div className="mb-3 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] p-3">
          <div className="mb-1.5 flex items-center justify-between text-[9px] uppercase tracking-[0.18em] text-[var(--text-3)]">
            <span>{`// EXPECTED THIS CYCLE`}</span>
            <span className="text-[var(--text-2)]">
              <DateLabel iso={estimate.window.start} format="short" />
              {" – "}
              <DateLabel iso={estimate.window.end} format="short" />
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-[20px] font-bold tabular text-[var(--text-0)]">
              <Money cents={estimate.totalCents} />
            </span>
            <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-2)]">
              {linkedBillCount} ITEM{linkedBillCount === 1 ? "" : "S"} LINKED
            </span>
          </div>
          {estimate.charges.length > 0 ? (
            <details className="mt-2 text-[10px]">
              <summary className="cursor-pointer text-[var(--text-3)] hover:text-[var(--text-1)] uppercase tracking-[0.12em]">
                {`// BREAKDOWN (${estimate.charges.length})`}
              </summary>
              <table className="mt-1.5 w-full text-[10px] tabular">
                <tbody>
                  {estimate.charges
                    .slice()
                    .sort((a, b) => a.date.localeCompare(b.date))
                    .map((c) => (
                      <tr key={`${c.sourceType}-${c.sourceId}-${c.date}`} className="border-b border-[var(--border-raw)] last:border-0">
                        <td className="py-1 pr-2 text-[var(--text-2)] uppercase tracking-tight">
                          <DateLabel iso={c.date} format="short" />
                        </td>
                        <td className="py-1 pr-2 text-[var(--text-1)] truncate max-w-[160px]">
                          {c.name}
                        </td>
                        <td className="py-1 text-right tabular text-[var(--text-0)]">
                          <Money cents={c.amountCents} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </details>
          ) : (
            <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">
              No linked spend falls in this cycle window
            </div>
          )}
          {current && isOpen ? (
            <ActualVsEstimate
              actualCents={statementCashDueCents(current)}
              estimatedCents={estimate.totalCents}
            />
          ) : null}
        </div>
      ) : null}

      {/* promotional financing */}
      <PromosSection
        card={card}
        promos={promos}
        paymentsByPromoId={paymentsByPromoId}
        today={today}
        onAdd={onAddPromo}
        onEdit={onEditPromo}
        onWhatIf={onPromoWhatIf}
        onCardWhatIf={onCardPromoWhatIf}
        onSchedule={onPromoSchedule}
        onReconcile={onReconcilePromos}
      />

      {/* recent statement history */}
      {statements.length > 1 ? (
        <details className="text-[10px]">
          <summary className="cursor-pointer text-[10px] uppercase tracking-[0.15em] text-[var(--text-3)] hover:text-[var(--text-1)]">
            {`// HISTORY (${statements.length - 1} more)`}
          </summary>
          <div className="mt-2 max-h-40 overflow-y-auto">
            <table className="w-full text-[10px] tabular">
              <tbody>
                {statements
                  .filter((s) => s.id !== current?.id)
                  .slice(0, 10)
                  .map((s) => {
                    const ok = paidWithoutInterest(s);
                    return (
                      <tr
                        key={s.id}
                        className="cursor-pointer border-b border-[var(--border-raw)] last:border-0 hover:bg-[var(--bg-2)]"
                        onClick={() => onEditStatement(s)}
                      >
                        <td className="py-1.5 pr-2 text-[var(--text-2)]">
                          <DateLabel iso={s.statementDate} format="short" />
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular">
                          <Money cents={s.statementBalanceCents} />
                        </td>
                        <td className="py-1.5 text-right">
                          {isStatementOpen(s) ? (
                            <span className="text-[var(--amber)]">UNPAID</span>
                          ) : ok ? (
                            <span className="text-[var(--mint)]">OK</span>
                          ) : (
                            <span className="text-[var(--amber)]">LATE</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Linked-card statement history snapshot
// ─────────────────────────────────────────────────────────────────────────────

function LinkedStatementSummary({
  statements,
  today,
}: {
  statements: CreditCardStatementRow[];
  today: string;
}) {
  const summary = React.useMemo(
    () => summarizeStatementBalances(statements, today),
    [statements, today],
  );

  if (
    summary.lastClosedCents == null &&
    summary.avg3MoCents == null &&
    summary.avg6MoCents == null &&
    summary.avg12MoCents == null
  ) {
    return null;
  }

  return (
    <div className="mb-3 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] p-3">
      <div className="mb-2 flex items-center justify-between text-[9px] uppercase tracking-[0.18em] text-[var(--text-3)]">
        <span>{`// STATEMENT HISTORY`}</span>
        <StatusPill>LINKED</StatusPill>
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <SummaryStat
          label="LAST STMT"
          cents={summary.lastClosedCents}
          sub={
            summary.lastClosedDate ? (
              <DateLabel iso={summary.lastClosedDate} format="short" />
            ) : (
              "—"
            )
          }
        />
        <SummaryStat
          label="3M AVG"
          cents={summary.avg3MoCents}
          sub={`${summary.avg3MoCount} STMT${summary.avg3MoCount === 1 ? "" : "S"}`}
        />
        <SummaryStat
          label="6M AVG"
          cents={summary.avg6MoCents}
          sub={`${summary.avg6MoCount} STMT${summary.avg6MoCount === 1 ? "" : "S"}`}
        />
        <SummaryStat
          label="12M AVG"
          cents={summary.avg12MoCents}
          sub={`${summary.avg12MoCount} STMT${summary.avg12MoCount === 1 ? "" : "S"}`}
        />
      </div>
    </div>
  );
}

function SummaryStat({
  label,
  cents,
  sub,
}: {
  label: string;
  cents: number | null;
  sub: React.ReactNode;
}) {
  return (
    <div className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-1)] px-2 py-1.5">
      <div className="mb-0.5 text-[9px] uppercase tracking-[0.15em] text-[var(--text-3)]">
        {label}
      </div>
      <div className="text-[14px] font-bold leading-none tabular text-[var(--text-0)]">
        {cents == null ? <span className="text-[var(--text-3)]">—</span> : <Money cents={cents} />}
      </div>
      <div className="mt-1 text-[9px] uppercase tracking-[0.12em] text-[var(--text-3)]">{sub}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Card create/edit dialog
// ─────────────────────────────────────────────────────────────────────────────

function CardDialog({
  card,
  onClose,
  onSaved,
}: {
  card?: CreditCardRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!card;
  const [name, setName] = React.useState(card?.name ?? "");
  const [statementDay, setStatementDay] = React.useState(card?.statementDay ?? 5);
  const [statementCycleMode, setStatementCycleMode] = React.useState<StatementCycleMode>(
    card?.statementCycleMode === "interval_days" ? "interval_days" : "calendar_day",
  );
  const [statementCycleAnchorDate, setStatementCycleAnchorDate] = React.useState(
    card?.statementCycleAnchorDate ?? todayIso(),
  );
  const [statementCycleIntervalDays, setStatementCycleIntervalDays] = React.useState(
    card?.statementCycleIntervalDays ?? 31,
  );
  const [dueDay, setDueDay] = React.useState(card?.dueDay ?? 26);
  const [gracePeriodDays, setGracePeriodDays] = React.useState(card?.gracePeriodDays ?? 14);
  const [currentBalanceCents, setCurrentBalance] = React.useState<number>(
    card?.currentBalanceCents ?? 0,
  );
  const [trackCurrentBalance, setTrackCurrentBalance] = React.useState(
    card?.currentBalanceCents != null,
  );
  const [autoPay, setAutoPay] = React.useState(card?.autoPay ?? false);
  const [notes, setNotes] = React.useState(card?.notes ?? "");
  const [saving, setSaving] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(editing ? `/api/credit-cards/${card!.id}` : "/api/credit-cards", {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          statementDay,
          statementCycleMode,
          statementCycleAnchorDate:
            statementCycleMode === "interval_days" ? statementCycleAnchorDate : null,
          statementCycleIntervalDays,
          dueDay,
          gracePeriodDays,
          currentBalanceCents: trackCurrentBalance ? currentBalanceCents : null,
          autoPay,
          notes: notes.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "save failed");
      toast.success(editing ? "Card updated" : "Card added");
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <CardSubTag>{editing ? "EDIT_CARD" : "NEW_CARD"}</CardSubTag>
          <DialogTitle>{editing ? card!.name.toUpperCase() : "ADD CREDIT CARD"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="cc-name">NAME</Label>
            <Input
              id="cc-name"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Chase Freedom, Amex Gold…"
            />
          </div>
          <div className="space-y-1.5">
            <Label>STATEMENT CYCLE</Label>
            <Select
              value={statementCycleMode}
              onValueChange={(value) => setStatementCycleMode(value as StatementCycleMode)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="calendar_day">FIXED DAY OF MONTH</SelectItem>
                <SelectItem value="interval_days">EVERY N DAYS</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="cc-stmt">STATEMENT DAY (1-31)</Label>
              <Input
                id="cc-stmt"
                type="number"
                min={1}
                max={31}
                required={statementCycleMode === "calendar_day"}
                disabled={statementCycleMode === "interval_days"}
                value={statementDay}
                onChange={(e) => setStatementDay(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cc-due">DUE DAY (1-31)</Label>
              <Input
                id="cc-due"
                type="number"
                min={1}
                max={31}
                required
                value={dueDay}
                onChange={(e) => setDueDay(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cc-grace">GRACE DAYS (STATEMENT → DUE)</Label>
            <Input
              id="cc-grace"
              type="number"
              min={0}
              max={60}
              required
              value={gracePeriodDays}
              onChange={(e) => setGracePeriodDays(Number(e.target.value))}
            />
            <p className="text-[10px] tracking-wide text-[var(--text-3)]">
              Minimum days between statement close and payment due — most US issuers grant 21–25.
            </p>
          </div>
          {statementCycleMode === "interval_days" ? (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="cc-cycle-anchor">ANCHOR STATEMENT DATE</Label>
                <Input
                  id="cc-cycle-anchor"
                  type="date"
                  required
                  value={statementCycleAnchorDate}
                  onChange={(e) => setStatementCycleAnchorDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cc-cycle-days">CYCLE DAYS</Label>
                <Input
                  id="cc-cycle-days"
                  type="number"
                  min={1}
                  max={366}
                  required
                  value={statementCycleIntervalDays}
                  onChange={(e) => setStatementCycleIntervalDays(Number(e.target.value))}
                />
              </div>
            </div>
          ) : null}
          <div className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--text-2)]">
            {statementCycleMode === "interval_days"
              ? `STATEMENT CLOSES EVERY ${statementCycleIntervalDays} DAYS FROM ${statementCycleAnchorDate}`
              : `STATEMENT CLOSES ON DAY ${statementDay}`}
            {" -> "}
            PAYMENT DUE ON DAY {dueDay}
            {statementCycleMode === "calendar_day" && dueDay === statementDay ? (
              <span className="ml-2 text-[var(--red)]">DAYS MUST DIFFER</span>
            ) : null}
          </div>
          <label className="flex cursor-pointer items-center justify-between">
            <Label>AUTOPAY</Label>
            <Switch checked={autoPay} onCheckedChange={setAutoPay} />
          </label>
          <label className="flex cursor-pointer items-center justify-between border-y border-[var(--border-raw)] py-3">
            <div>
              <Label>TRACK CURRENT BALANCE</Label>
              <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">
                Used to project the next card payment before a statement exists
              </div>
            </div>
            <Switch checked={trackCurrentBalance} onCheckedChange={setTrackCurrentBalance} />
          </label>
          {trackCurrentBalance ? (
            <div className="space-y-1.5">
              <Label>CURRENT BALANCE</Label>
              <MoneyInput valueCents={currentBalanceCents} onChangeCents={setCurrentBalance} />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="cc-notes">NOTES</Label>
            <Input id="cc-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              CANCEL
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                saving ||
                !name.trim() ||
                (statementCycleMode === "calendar_day" && statementDay === dueDay) ||
                (statementCycleMode === "interval_days" &&
                  (!statementCycleAnchorDate || statementCycleIntervalDays < 1))
              }
            >
              {saving ? "SAVING…" : editing ? "SAVE CHANGES" : "ADD CARD"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// New statement dialog
// ─────────────────────────────────────────────────────────────────────────────

function StatementCreateDialog({
  card,
  existingStatements,
  onClose,
  onSaved,
}: {
  card: CreditCardRow;
  existingStatements: CreditCardStatementRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // Default statement date = most recent statement close on/before today.
  const today = todayIso();
  const defaultStatementDate = previousStatementDateOnOrBefore(today, card);
  const [statementDate, setStatementDate] = React.useState(defaultStatementDate);
  const [dueDate, setDueDate] = React.useState(
    dueDateFromStatement(defaultStatementDate, card.dueDay, card.gracePeriodDays),
  );
  const [statementBalanceCents, setBalance] = React.useState(0);
  const [notes, setNotes] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const dup = existingStatements.some((s) => s.statementDate === statementDate);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (statementBalanceCents < 0) return;
    if (dueDate < statementDate) {
      toast.error("Due date must be on or after statement date");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/credit-cards/${card.id}/statements`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          statementDate,
          dueDate,
          statementBalanceCents,
          notes: notes.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "create failed");
      toast.success("Statement entered");
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <CardSubTag>{`${card.name.toUpperCase()} // NEW_STATEMENT`}</CardSubTag>
          <DialogTitle>ENTER STATEMENT</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4 pt-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="stmt-date">STATEMENT DATE</Label>
              <Input
                id="stmt-date"
                type="date"
                required
                value={statementDate}
                onChange={(e) => {
                  setStatementDate(e.target.value);
                  setDueDate(dueDateFromStatement(e.target.value, card.dueDay, card.gracePeriodDays));
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="due-date">DUE DATE</Label>
              <Input
                id="due-date"
                type="date"
                required
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>STATEMENT BALANCE (PAY THIS TO AVOID INTEREST)</Label>
            <MoneyInput valueCents={statementBalanceCents} onChangeCents={setBalance} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="stmt-notes">NOTES</Label>
            <Input id="stmt-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {dup ? (
            <div className="flex items-center gap-2 rounded-sm border border-[rgba(251,191,36,0.3)] bg-[rgba(251,191,36,0.08)] px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-[var(--amber)]">
              <AlertTriangle className="h-3 w-3" />
              A statement already exists for this date
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              CANCEL
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={saving || statementBalanceCents < 0}
            >
              {saving ? "SAVING…" : "SAVE STATEMENT"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit / mark paid
// ─────────────────────────────────────────────────────────────────────────────

function StatementEditDialog({
  statement,
  onClose,
  onSaved,
}: {
  statement: CreditCardStatementRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [paidAmountCents, setPaidAmount] = React.useState<number>(
    statement.paidAmountCents ?? statementCashDueCents(statement),
  );
  const [paidDate, setPaidDate] = React.useState<string>(statement.paidDate ?? todayIso());
  const [statementBalanceCents, setBalance] = React.useState(statement.statementBalanceCents);
  const [statementDate, setStatementDate] = React.useState(statement.statementDate);
  const [dueDate, setDueDate] = React.useState(statement.dueDate);
  const [paidToggle, setPaidToggle] = React.useState(statement.paidAmountCents != null);
  const [notes, setNotes] = React.useState(statement.notes ?? "");
  const [saving, setSaving] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`/api/credit-cards/statements/${statement.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          statementDate,
          dueDate,
          statementBalanceCents,
          paidAmountCents: paidToggle ? paidAmountCents : null,
          paidDate: paidToggle ? paidDate : null,
          notes: notes.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "save failed");
      toast.success(paidToggle ? "Marked paid" : "Statement updated");
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm("Delete this statement? This cannot be undone.")) return;
    const res = await fetch(`/api/credit-cards/statements/${statement.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Delete failed");
      return;
    }
    toast.success("Statement deleted");
    onSaved();
  };

  const cashDueCents = statementBalanceCents > 0
    ? statementBalanceCents
    : (statement.minimumPaymentCents ?? 0);
  const willAvoidInterest =
    paidToggle && paidAmountCents >= cashDueCents && paidDate <= dueDate;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <CardSubTag>EDIT_STATEMENT</CardSubTag>
          <DialogTitle>STATEMENT — {statement.statementDate}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4 pt-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>STATEMENT DATE</Label>
              <Input
                type="date"
                value={statementDate}
                onChange={(e) => setStatementDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>DUE DATE</Label>
              <Input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Statement balance</Label>
            <MoneyInput valueCents={statementBalanceCents} onChangeCents={setBalance} />
          </div>
          <div className="flex items-center justify-between border-y border-[var(--border-raw)] py-3">
            <Label>Mark as paid</Label>
            <Switch aria-label="Mark as paid" checked={paidToggle} onCheckedChange={setPaidToggle} />
          </div>
          {paidToggle ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>PAID AMOUNT</Label>
                  <MoneyInput valueCents={paidAmountCents} onChangeCents={setPaidAmount} />
                </div>
                <div className="space-y-1.5">
                  <Label>PAID DATE</Label>
                  <Input
                    type="date"
                    value={paidDate}
                    onChange={(e) => setPaidDate(e.target.value)}
                  />
                </div>
              </div>
              <div
                className={cn(
                  "flex items-center gap-2 rounded-sm border px-3 py-2 text-[10px] uppercase tracking-[0.12em]",
                  willAvoidInterest
                    ? "border-[var(--mint-dim)] bg-[var(--mint-glow)] text-[var(--mint)]"
                    : "border-[rgba(251,191,36,0.3)] bg-[rgba(251,191,36,0.08)] text-[var(--amber)]",
                )}
              >
                {willAvoidInterest ? (
                  <>
                    <CheckCircle2 className="h-3 w-3" /> NO INTEREST — FULL BALANCE PAID ON TIME
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-3 w-3" />
                    {paidAmountCents < cashDueCents
                      ? "PARTIAL PAYMENT — INTEREST WILL ACCRUE ON REMAINDER"
                      : "PAID AFTER DUE DATE — INTEREST MAY APPLY"}
                  </>
                )}
              </div>
            </>
          ) : null}
          <div className="space-y-1.5">
            <Label>NOTES</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="destructive" onClick={remove} disabled={saving}>
              <Trash2 className="h-3 w-3" /> DELETE
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
                CANCEL
              </Button>
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? "SAVING…" : "SAVE"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Small inline diff between the real statement balance and the bill-derived
// estimate. Useful sanity check — large positive deltas mean discretionary
// spend on top of recurring bills; large negative deltas mean an expected
// bill didn't post yet (or got paid via cash).
function ActualVsEstimate({
  actualCents,
  estimatedCents,
}: {
  actualCents: number;
  estimatedCents: number;
}) {
  if (estimatedCents === 0) return null;
  const delta = actualCents - estimatedCents;
  const tone =
    Math.abs(delta) <= Math.max(500, estimatedCents * 0.05) // within $5 or 5%
      ? "text-[var(--mint)]"
      : delta > 0
        ? "text-[var(--amber)]"
        : "text-[var(--text-2)]";
  return (
    <div className="mt-2 flex items-center justify-between border-t border-[var(--border-raw)] pt-2 text-[10px] uppercase tracking-[0.12em]">
      <span className="text-[var(--text-3)]">VS CURRENT STATEMENT</span>
      <span className={cn("tabular", tone)}>
        {delta >= 0 ? "+" : "−"}
        <Money cents={Math.abs(delta)} />
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Deferred-interest financing — list + summary inside a card tile
// ─────────────────────────────────────────────────────────────────────────────

function PromosSection({
  card,
  promos,
  paymentsByPromoId,
  today,
  onAdd,
  onEdit,
  onWhatIf,
  onCardWhatIf,
  onSchedule,
  onReconcile,
}: {
  card: CreditCardRow;
  promos: CreditCardPromoRow[];
  paymentsByPromoId: Record<string, PromoScheduledPayment[]>;
  today: string;
  onAdd: () => void;
  onEdit: (p: CreditCardPromoRow) => void;
  onWhatIf: (p: CreditCardPromoRow) => void;
  onCardWhatIf: () => void;
  onSchedule: (p: CreditCardPromoRow) => void;
  onReconcile: () => void;
}) {
  const active = promos.filter((p) => p.isActive && p.remainingAmountCents > 0);
  const totalRemaining = active.reduce((s, p) => s + p.remainingAmountCents, 0);

  return (
    <div className="mb-3 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] p-3">
      <div className="mb-2 flex items-center justify-between text-[9px] uppercase tracking-[0.18em] text-[var(--text-3)]">
        <span className="flex items-center gap-1.5">
          <Sparkles className="h-3 w-3 text-[var(--cyan)]" />
          {`// DEFERRED-INTEREST PROMOS (${active.length})`}
        </span>
        <span className="flex items-center">
          <Button size="sm" variant="ghost" onClick={onReconcile} title="Reconcile from a pasted PayPal promo list">
            <ClipboardPaste className="h-3 w-3" /> RECONCILE
          </Button>
          <Button size="sm" variant="ghost" onClick={onAdd}>
            <Plus className="h-3 w-3" /> ADD
          </Button>
        </span>
      </div>
      <div className="mb-2 text-[10px] tracking-wide text-[var(--text-2)]">
        No interest only when paid in full by each deadline. Missing a deadline may trigger
        interest back to the purchase date.
      </div>

      {active.length === 0 ? (
        <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">
          No active promos. Track no-interest-if-paid-in-full financing across cycles.
        </div>
      ) : (
        <>
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[18px] font-bold tabular text-[var(--text-0)]">
              <Money cents={totalRemaining} />
            </span>
            <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-2)]">
              REMAINING
            </span>
          </div>

          <ul className="space-y-1.5">
            {active.map((p) => {
              const sched = paymentsByPromoId[p.id] ?? [];
              const hasManualSchedule = sched.length > 0;
              const chunk = hasManualSchedule
                ? (sched.find((s) => s.dueDate >= today)?.amountCents ?? 0)
                : promoMonthlyChunkAt(p, today);
              const daysLeft = daysBetween(today, p.endDate);
              const tone =
                daysLeft < 0
                  ? "text-[var(--red)]"
                  : daysLeft <= 30
                    ? "text-[var(--amber)]"
                    : "text-[var(--text-1)]";
              return (
                <li
                  key={p.id}
                  className="flex items-center justify-between gap-2 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-1)] px-2 py-1.5"
                >
                  <button
                    type="button"
                    onClick={() => onEdit(p)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-1.5 truncate text-[11px] tracking-tight text-[var(--text-0)]">
                      <span className="truncate">{p.description}</span>
                      {hasManualSchedule ? (
                        <span className="shrink-0 rounded-sm border border-[var(--cyan)] px-1 py-[1px] text-[8px] uppercase tracking-[0.14em] text-[var(--cyan)]">
                          PLAN
                        </span>
                      ) : null}
                    </div>
                    <div className="text-[9px] uppercase tracking-[0.12em] text-[var(--text-2)]">
                      <span className="tabular text-[var(--text-1)]">
                        <Money cents={chunk} />
                      </span>
                      {hasManualSchedule
                        ? ` NEXT · ${sched.length} PLANNED · ENDS `
                        : "/MO · ENDS "}
                      <span className={tone}>
                        <DateLabel iso={p.endDate} format="short" />
                      </span>
                    </div>
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onSchedule(p)}
                    title={hasManualSchedule ? "Edit payment schedule" : "Set custom payment schedule"}
                  >
                    <CalendarDays className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onWhatIf(p)}
                    title="What-if comparison"
                  >
                    <Scale className="h-3 w-3" />
                  </Button>
                </li>
              );
            })}
          </ul>

          {active.length > 1 ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-2 w-full"
              onClick={onCardWhatIf}
            >
              <Scale className="h-3 w-3" /> COMPARE PAY ALL VS SCHEDULE
            </Button>
          ) : null}
        </>
      )}
      {/* keep the card prop referenced so eslint doesn't flag it; future use */}
      <span className="hidden">{card.id}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Promo create/edit dialog
// ─────────────────────────────────────────────────────────────────────────────

function PromoDialog({
  card,
  promo,
  onClose,
  onSaved,
}: {
  card: CreditCardRow;
  promo?: CreditCardPromoRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = !!promo;
  const today = todayIso();
  const [description, setDescription] = React.useState(promo?.description ?? "");
  const [originalAmountCents, setOriginalAmount] = React.useState(
    promo?.originalAmountCents ?? 0,
  );
  const [remainingAmountCents, setRemaining] = React.useState(
    promo?.remainingAmountCents ?? 0,
  );
  const [startDate, setStartDate] = React.useState(promo?.startDate ?? today);
  const [endDate, setEndDate] = React.useState(promo?.endDate ?? "");
  const [overrideMonthly, setOverrideMonthly] = React.useState(
    promo?.monthlyPaymentCents != null,
  );
  const [monthlyPaymentCents, setMonthlyPayment] = React.useState(
    promo?.monthlyPaymentCents ?? 0,
  );
  const [notes, setNotes] = React.useState(promo?.notes ?? "");
  const [saving, setSaving] = React.useState(false);

  // Auto-fill remaining = original on create when user types original first
  React.useEffect(() => {
    if (!editing && originalAmountCents > 0 && remainingAmountCents === 0) {
      setRemaining(originalAmountCents);
    }
  }, [editing, originalAmountCents, remainingAmountCents]);

  const computedChunk = React.useMemo(() => {
    if (!endDate || remainingAmountCents <= 0) return 0;
    return promoMonthlyChunkAt(
      {
        remainingAmountCents,
        monthlyPaymentCents: overrideMonthly ? monthlyPaymentCents : null,
        endDate,
      },
      today,
    );
  }, [endDate, remainingAmountCents, overrideMonthly, monthlyPaymentCents, today]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!endDate) {
      toast.error("End date required");
      return;
    }
    if (endDate < startDate) {
      toast.error("End date must be on or after start date");
      return;
    }
    if (originalAmountCents <= 0) {
      toast.error("Original amount must be positive");
      return;
    }
    setSaving(true);
    try {
      const url = editing
        ? `/api/credit-cards/promos/${promo!.id}`
        : `/api/credit-cards/${card.id}/promos`;
      const res = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          originalAmountCents,
          remainingAmountCents,
          startDate,
          endDate,
          monthlyPaymentCents: overrideMonthly ? monthlyPaymentCents : null,
          notes: notes.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "save failed");
      toast.success(editing ? "Promo updated" : "Promo added");
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    if (!promo) return;
    if (!confirm("Archive this promo? Future projection chunks will stop.")) return;
    const res = await fetch(`/api/credit-cards/promos/${promo.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Archive failed");
      return;
    }
    toast.success("Promo archived");
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <CardSubTag>{`${card.name.toUpperCase()} // ${editing ? "EDIT_PROMO" : "NEW_PROMO"}`}</CardSubTag>
          <DialogTitle>{editing ? "EDIT PROMO" : "ADD DEFERRED-INTEREST PROMO"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="promo-desc">DESCRIPTION</Label>
            <Input
              id="promo-desc"
              required
              maxLength={120}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="MacBook Pro, Dental work…"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>ORIGINAL AMOUNT</Label>
              <MoneyInput valueCents={originalAmountCents} onChangeCents={setOriginalAmount} />
            </div>
            <div className="space-y-1.5">
              <Label>REMAINING</Label>
              <MoneyInput valueCents={remainingAmountCents} onChangeCents={setRemaining} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>START DATE</Label>
              <Input
                type="date"
                required
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>END DATE (PAY-OFF DEADLINE)</Label>
              <Input
                type="date"
                required
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>
          <label className="flex cursor-pointer items-center justify-between border-y border-[var(--border-raw)] py-3">
            <div>
              <Label>SET DESIRED MONTHLY PAYMENT</Label>
              <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">
                {overrideMonthly
                  ? "INCLUDED IN EACH PROJECTED CYCLE"
                  : "AUTO: REMAINING ÷ MONTHS LEFT"}
              </div>
            </div>
            <Switch checked={overrideMonthly} onCheckedChange={setOverrideMonthly} />
          </label>
          {overrideMonthly ? (
            <div className="space-y-1.5">
              <Label>DESIRED MONTHLY PAYMENT</Label>
              <MoneyInput valueCents={monthlyPaymentCents} onChangeCents={setMonthlyPayment} />
            </div>
          ) : null}
          <div className="rounded-sm border border-[var(--cyan-dim,var(--border-raw))] bg-[var(--bg-2)] px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-[var(--text-2)]">
            PROJECTED MONTHLY CHUNK:{" "}
            <span className="text-[var(--cyan)] tabular">
              <Money cents={computedChunk} />
            </span>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="promo-notes">NOTES</Label>
            <Input
              id="promo-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
            />
          </div>
          <DialogFooter>
            {editing ? (
              <Button type="button" variant="destructive" onClick={archive} disabled={saving}>
                <Trash2 className="h-3 w-3" /> ARCHIVE
              </Button>
            ) : null}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
                CANCEL
              </Button>
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? "SAVING…" : editing ? "SAVE CHANGES" : "ADD PROMO"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// What-if comparison sheet (per-promo or whole card)
// ─────────────────────────────────────────────────────────────────────────────

function PromoWhatIfSheet({
  scope,
  card,
  promos,
  paymentsByPromoId,
  onClose,
}: {
  scope: "promo" | "card";
  card: CreditCardRow;
  promos: CreditCardPromoRow[];
  paymentsByPromoId: Record<string, PromoScheduledPayment[]>;
  onClose: () => void;
}) {
  const today = todayIso();
  const whatIf = React.useMemo(() => {
    if (scope === "promo" && promos.length === 1) {
      return promoWhatIf(
        promos[0]!,
        card,
        today,
        paymentsByPromoId[promos[0]!.id] ?? [],
      );
    }
    const map = new Map(
      promos.map((p) => [p.id, paymentsByPromoId[p.id] ?? []] as const),
    );
    return cardPromoWhatIf(promos, card, today, map);
  }, [scope, promos, card, today, paymentsByPromoId]);

  const title =
    scope === "promo" && promos.length === 1
      ? promos[0]!.description.toUpperCase()
      : `${card.name.toUpperCase()} — ALL PROMOS`;

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <SheetHeader>
          <CardSubTag>{`${card.name.toUpperCase()} // WHAT_IF`}</CardSubTag>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <SheetBody className="space-y-4">
          <div className="text-[11px] tracking-wide text-[var(--text-2)]">
            Side-by-side cash impact. The numbers are the math; the call is yours.
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Pay off now */}
            <div className="rounded-sm border border-[var(--border-2)] bg-[var(--bg-1)] p-3">
              <div className="mb-1 text-[9px] uppercase tracking-[0.2em] text-[var(--text-3)]">
                {`// PAY OFF TODAY`}
              </div>
              <div className="mb-1 text-[22px] font-bold leading-none tabular text-[var(--cyan)]">
                <Money cents={whatIf.payOffNow.totalCents} />
              </div>
              <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-2)]">
                CASH OUT <DateLabel iso={whatIf.payOffNow.cashOutDate} format="short" />
              </div>
              <div className="mt-3 border-t border-[var(--border-raw)] pt-2 text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">
                FUTURE CHUNKS: <span className="text-[var(--mint)]">NONE</span>
              </div>
            </div>

            {/* Continue schedule */}
            <div className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-1)] p-3">
              <div className="mb-1 text-[9px] uppercase tracking-[0.2em] text-[var(--text-3)]">
                {`// CONTINUE SCHEDULE`}
              </div>
              <div className="mb-1 text-[22px] font-bold leading-none tabular text-[var(--text-0)]">
                <Money cents={whatIf.continueSchedule.totalCents} />
              </div>
              <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-2)]">
                {whatIf.continueSchedule.finalDueDate ? (
                  <>
                    THROUGH{" "}
                    <DateLabel iso={whatIf.continueSchedule.finalDueDate} format="short" />
                  </>
                ) : (
                  "NO FUTURE CHUNKS"
                )}
              </div>
              <div className="mt-3 border-t border-[var(--border-raw)] pt-2 text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">
                {whatIf.continueSchedule.chunks.length} PAYMENT
                {whatIf.continueSchedule.chunks.length === 1 ? "" : "S"}
              </div>
            </div>
          </div>

          {whatIf.continueSchedule.chunks.length > 0 ? (
            <div>
              <div className="mb-2 text-[9px] uppercase tracking-[0.18em] text-[var(--text-3)]">
                {`// SCHEDULE`}
              </div>
              <div className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-1)]">
                <table className="w-full text-[11px] tabular">
                  <thead>
                    <tr className="border-b border-[var(--border-raw)] text-[9px] uppercase tracking-[0.12em] text-[var(--text-3)]">
                      <th className="px-3 py-1.5 text-left">DUE</th>
                      <th className="px-3 py-1.5 text-right">AMOUNT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {whatIf.continueSchedule.chunks.map((c) => (
                      <tr
                        key={c.dueDate}
                        className="border-b border-[var(--border-raw)] last:border-0"
                      >
                        <td className="px-3 py-1.5 text-[var(--text-1)]">
                          <DateLabel iso={c.dueDate} format="short" />
                        </td>
                        <td className="px-3 py-1.5 text-right text-[var(--text-0)]">
                          <Money cents={c.amountCents} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <div className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] p-3 text-[10px] uppercase tracking-[0.12em] text-[var(--text-2)]">
            BOTH PATHS PAY THE SAME PRINCIPAL ASSUMING YOU MEET THE DEADLINE.
            DIFFERENCE IS{" "}
            <span className="text-[var(--cyan)]">CASH-FLOW TIMING</span> ONLY — INTEREST IS
            ZERO EITHER WAY WHEN PAID BY{" "}
            {scope === "promo" && promos.length === 1 ? (
              <DateLabel iso={promos[0]!.endDate} format="short" />
            ) : (
              "EACH PROMO'S DEADLINE"
            )}
            .
          </div>
        </SheetBody>
        <SheetFooter>
          <Button variant="outline" onClick={onClose}>
            CLOSE
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment-schedule editor: split a promo's remaining balance across custom
// (date, amount) rows. When any rows exist, the projection uses them verbatim
// instead of the auto-spread / monthlyPaymentCents logic.
// ─────────────────────────────────────────────────────────────────────────────

type DraftPayment = {
  /** Stable key for React (UUID-ish via Math.random — not persisted). */
  key: string;
  dueDate: string;
  amountCents: number;
  note: string | null;
};

function makeDraftKey() {
  return Math.random().toString(36).slice(2);
}

function PromoScheduleSheet({
  card,
  promo,
  initialPayments,
  onClose,
  onSaved,
}: {
  card: CreditCardRow;
  promo: CreditCardPromoRow;
  initialPayments: PromoScheduledPayment[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const today = todayIso();
  const [drafts, setDrafts] = React.useState<DraftPayment[]>(() =>
    initialPayments.map((p) => ({
      key: p.id,
      dueDate: p.dueDate,
      amountCents: p.amountCents,
      note: p.note,
    })),
  );
  const [saving, setSaving] = React.useState(false);

  const sorted = React.useMemo(
    () => [...drafts].sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    [drafts],
  );

  const totalScheduled = sorted.reduce((s, d) => s + d.amountCents, 0);
  const original = promo.originalAmountCents;
  const remaining = promo.remainingAmountCents;
  // Compare scheduled total against the *current* remaining (what still needs
  // to be paid), not the original. The user often opens this AFTER some
  // amount has already been paid down via prior statements.
  const gap = remaining - totalScheduled; // positive: short, negative: over

  const addRow = () => {
    setDrafts((d) => [
      ...d,
      {
        key: makeDraftKey(),
        dueDate: today,
        amountCents: 0,
        note: null,
      },
    ]);
  };

  const updateRow = (key: string, patch: Partial<DraftPayment>) => {
    setDrafts((d) => d.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const deleteRow = (key: string) => {
    setDrafts((d) => d.filter((r) => r.key !== key));
  };

  const fillEvenly = () => {
    if (drafts.length === 0) {
      toast.error("Add at least one payment row first");
      return;
    }
    const each = Math.floor(remaining / drafts.length);
    const extra = remaining - each * drafts.length;
    setDrafts((d) =>
      d
        .slice()
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
        .map((r, i) => ({ ...r, amountCents: each + (i === 0 ? extra : 0) })),
    );
  };

  const save = async () => {
    // Validate: dates required, amounts > 0
    for (const d of sorted) {
      if (!d.dueDate) {
        toast.error("Every row needs a date");
        return;
      }
      if (d.amountCents <= 0) {
        toast.error("Every row needs a positive amount");
        return;
      }
      if (d.dueDate > promo.endDate) {
        toast.error(`Every payment must be on or before ${promo.endDate}`);
        return;
      }
    }
    if (sorted.length > 0 && gap !== 0) {
      toast.error("Schedule must exactly equal the remaining promotional balance");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/credit-cards/promos/${promo.id}/payments`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payments: sorted.map((d) => ({
            dueDate: d.dueDate,
            amountCents: d.amountCents,
            note: d.note?.trim() ? d.note.trim() : null,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "save failed");
      toast.success(
        sorted.length === 0 ? "Schedule cleared (auto-spread)" : "Schedule saved",
      );
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const clearAll = () => {
    if (drafts.length === 0) return;
    if (!confirm("Clear all scheduled payments? Promo will fall back to auto-spread.")) return;
    setDrafts([]);
  };

  // Running remaining-after-each-payment, computed on the sorted list so the
  // user always sees the math by date order regardless of input sequence.
  let running = remaining;
  const rowsWithRunning = sorted.map((d) => {
    running = running - d.amountCents;
    return { ...d, runningAfter: running };
  });

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <SheetHeader>
          <CardSubTag>{`${card.name.toUpperCase()} // PAYMENT_PLAN`}</CardSubTag>
          <SheetTitle>{promo.description.toUpperCase()}</SheetTitle>
        </SheetHeader>
        <SheetBody className="space-y-4">
          <div className="grid grid-cols-3 gap-2 text-[10px] uppercase tracking-[0.12em]">
            <div className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-1)] p-2">
              <div className="text-[var(--text-3)]">ORIGINAL</div>
              <div className="mt-0.5 text-[14px] font-bold tabular text-[var(--text-1)]">
                <Money cents={original} />
              </div>
            </div>
            <div className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-1)] p-2">
              <div className="text-[var(--text-3)]">REMAINING</div>
              <div className="mt-0.5 text-[14px] font-bold tabular text-[var(--text-0)]">
                <Money cents={remaining} />
              </div>
            </div>
            <div className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-1)] p-2">
              <div className="text-[var(--text-3)]">DEADLINE</div>
              <div className="mt-0.5 text-[12px] font-bold uppercase tracking-[0.12em] text-[var(--text-1)]">
                <DateLabel iso={promo.endDate} format="short" />
              </div>
            </div>
          </div>

          <div className="text-[11px] tracking-wide text-[var(--text-2)]">
            Pick exact dates and amounts through the deadline. The schedule must
            cover the full remaining balance; actual balances change only when reconciled.
          </div>

          {sorted.length === 0 ? (
            <div className="rounded-sm border border-dashed border-[var(--border-raw)] bg-[var(--bg-2)] p-4 text-center text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">
              NO MANUAL PAYMENTS — PROMO USES AUTO-SPREAD
              <div className="mt-2">
                <Button size="sm" variant="primary" onClick={addRow}>
                  <Plus className="h-3 w-3" /> ADD FIRST PAYMENT
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-1)]">
              <div className="grid grid-cols-[1fr_1fr_1.2fr_1fr_auto] items-center gap-2 border-b border-[var(--border-raw)] px-3 py-1.5 text-[9px] uppercase tracking-[0.12em] text-[var(--text-3)]">
                <span>DUE</span>
                <span className="text-right">AMOUNT</span>
                <span>NOTE</span>
                <span className="text-right">REMAINING AFTER</span>
                <span className="w-6"></span>
              </div>
              {rowsWithRunning.map((r) => {
                const overdraw = r.runningAfter < 0;
                return (
                  <div
                    key={r.key}
                    className="grid grid-cols-[1fr_1fr_1.2fr_1fr_auto] items-center gap-2 border-b border-[var(--border-raw)] px-3 py-1.5 last:border-0"
                  >
                    <Input
                      type="date"
                      value={r.dueDate}
                      onChange={(e) => updateRow(r.key, { dueDate: e.target.value })}
                      className="h-8 text-[11px]"
                    />
                    <MoneyInput
                      valueCents={r.amountCents}
                      onChangeCents={(v) => updateRow(r.key, { amountCents: v })}
                    />
                    <Input
                      placeholder="optional"
                      maxLength={500}
                      value={r.note ?? ""}
                      onChange={(e) =>
                        updateRow(r.key, { note: e.target.value || null })
                      }
                      className="h-8 text-[11px]"
                    />
                    <span
                      className={cn(
                        "text-right text-[11px] tabular",
                        overdraw ? "text-[var(--red)]" : "text-[var(--text-1)]",
                      )}
                    >
                      <Money cents={r.runningAfter} />
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => deleteRow(r.key)}
                      title="Remove"
                    >
                      <Trash2 className="h-3 w-3 text-[var(--red)]" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {sorted.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={addRow}>
                <Plus className="h-3 w-3" /> ADD ROW
              </Button>
              <Button size="sm" variant="outline" onClick={fillEvenly}>
                FILL EVENLY ACROSS ROWS
              </Button>
              <Button size="sm" variant="ghost" onClick={clearAll}>
                CLEAR ALL
              </Button>
            </div>
          ) : null}

          <div className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] p-3 text-[10px] uppercase tracking-[0.12em] text-[var(--text-2)]">
            <div className="flex items-baseline justify-between">
              <span>SCHEDULED TOTAL</span>
              <span className="text-[14px] font-bold tabular text-[var(--text-0)]">
                <Money cents={totalScheduled} />
              </span>
            </div>
            <div className="mt-1 flex items-baseline justify-between">
              <span>VS REMAINING</span>
              <span
                className={cn(
                  "text-[12px] font-bold tabular",
                  gap > 0
                    ? "text-[var(--amber)]"
                    : gap < 0
                      ? "text-[var(--red)]"
                      : "text-[var(--phosphor)]",
                )}
              >
                {gap > 0 ? (
                  <>
                    SHORT <Money cents={gap} />
                  </>
                ) : gap < 0 ? (
                  <>
                    OVER <Money cents={-gap} />
                  </>
                ) : (
                  "EXACT"
                )}
              </span>
            </div>
            {sorted.length > 0 ? (
              <div className="mt-2 text-[var(--text-3)]">
                LAST PAYMENT{" "}
                <DateLabel iso={sorted[sorted.length - 1]!.dueDate} format="short" />
              </div>
            ) : null}
          </div>
        </SheetBody>
        <SheetFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            CANCEL
          </Button>
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? "SAVING…" : "SAVE SCHEDULE"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// kept exported in case future iterations want a flat statements list
export type { StatementWithCard };
