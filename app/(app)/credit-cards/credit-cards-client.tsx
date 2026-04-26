"use client";

import * as React from "react";
import { Plus, Trash2, AlertTriangle, CheckCircle2, FileText } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { MoneyInput } from "@/components/money-input";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import {
  CardWithStatements,
  currentStatementOf,
  daysBetween,
  dueDateFromStatement,
  isStatementOpen,
  nextDayOfMonthOnOrAfter,
  paidWithoutInterest,
  totalDue,
} from "@/lib/credit-cards";
import { todayIso } from "@/lib/dates";
import { cn } from "@/lib/cn";
import type {
  CreditCardRow,
  CreditCardStatementRow,
} from "@/lib/db/schema";

type StatementWithCard = CreditCardStatementRow & { cardName: string; cardId: string };

export function CreditCardsClient({ initialCards }: { initialCards: CardWithStatements[] }) {
  const [cards, setCards] = React.useState<CardWithStatements[]>(initialCards);
  const [createCardOpen, setCreateCardOpen] = React.useState(false);
  const [editCard, setEditCard] = React.useState<CreditCardRow | null>(null);
  const [statementCard, setStatementCard] = React.useState<CreditCardRow | null>(null);
  const [editStatement, setEditStatement] = React.useState<{ cardId: string; statement: CreditCardStatementRow } | null>(null);

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

  // ── refresh after writes ────────────────────────────────────────────────
  const refresh = async () => {
    const res = await fetch("/api/credit-cards?archived=1");
    if (res.ok) {
      const json = await res.json();
      setCards(json.cards as CardWithStatements[]);
    }
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

      <TileGrid cols={4}>
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
          label="NEXT PAYMENT"
          value={
            nextDue ? (
              <Money cents={nextDue.statementBalanceCents} />
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
          {activeCards.map(({ card, statements }) => (
            <CreditCardTile
              key={card.id}
              card={card}
              statements={statements}
              today={today}
              onAddStatement={() => setStatementCard(card)}
              onEdit={() => setEditCard(card)}
              onArchive={() => archiveCard(card.id)}
              onEditStatement={(s) => setEditStatement({ cardId: card.id, statement: s })}
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
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Single card tile
// ─────────────────────────────────────────────────────────────────────────────

function CreditCardTile({
  card,
  statements,
  today,
  onAddStatement,
  onEdit,
  onArchive,
  onEditStatement,
}: {
  card: CreditCardRow;
  statements: CreditCardStatementRow[];
  today: string;
  onAddStatement: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onEditStatement: (s: CreditCardStatementRow) => void;
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
            STATEMENT D{card.statementDay} · DUE D{card.dueDay}
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
                <DateLabel iso={nextDayOfMonthOnOrAfter(today, card.statementDay)} format="short" />
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
              <Money cents={current.statementBalanceCents} />
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
                          {s.paidAmountCents == null ? (
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
  const [dueDay, setDueDay] = React.useState(card?.dueDay ?? 26);
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
          dueDay,
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
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="cc-stmt">STATEMENT DAY (1–31)</Label>
              <Input
                id="cc-stmt"
                type="number"
                min={1}
                max={31}
                required
                value={statementDay}
                onChange={(e) => setStatementDay(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cc-due">DUE DAY (1–31)</Label>
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
          <div className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--text-2)]">
            STATEMENT CLOSES ON DAY {statementDay} → PAYMENT DUE ON DAY {dueDay}
            {dueDay === statementDay ? (
              <span className="ml-2 text-[var(--red)]">DAYS MUST DIFFER</span>
            ) : null}
          </div>
          <label className="flex cursor-pointer items-center justify-between">
            <Label>AUTOPAY</Label>
            <Switch checked={autoPay} onCheckedChange={setAutoPay} />
          </label>
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
              disabled={saving || !name.trim() || statementDay === dueDay}
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
  // Default statement date = next occurrence of card.statementDay on/before today
  const today = todayIso();
  const defaultStatementDate = nextDayOfMonthOnOrAfter(
    // Look up to 31 days in the past so we land on the most recently closed cycle
    new Date(new Date(today + "T00:00:00Z").getTime() - 31 * 86_400_000)
      .toISOString()
      .slice(0, 10),
    card.statementDay,
  );
  const [statementDate, setStatementDate] = React.useState(defaultStatementDate);
  const [dueDate, setDueDate] = React.useState(dueDateFromStatement(defaultStatementDate, card.dueDay));
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
                  setDueDate(dueDateFromStatement(e.target.value, card.dueDay));
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
    statement.paidAmountCents ?? statement.statementBalanceCents,
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

  const willAvoidInterest =
    paidToggle && paidAmountCents >= statementBalanceCents && paidDate <= dueDate;

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
            <Label>STATEMENT BALANCE</Label>
            <MoneyInput valueCents={statementBalanceCents} onChangeCents={setBalance} />
          </div>
          <label className="flex cursor-pointer items-center justify-between border-y border-[var(--border-raw)] py-3">
            <Label>MARK AS PAID</Label>
            <Switch checked={paidToggle} onCheckedChange={setPaidToggle} />
          </label>
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
                    {paidAmountCents < statementBalanceCents
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

// kept exported in case future iterations want a flat statements list
export type { StatementWithCard };
