"use client";

// Shared credit-card dialogs and sheets, used by both the wallet view
// (/credit-cards) and the per-card detail page (/credit-cards/[id]).

import * as React from "react";
import { Plus, Trash2, AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CardSubTag } from "@/components/ui/page-head";
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
import {
  cardPromoWhatIf,
  dueDateFromStatement,
  previousStatementDateOnOrBefore,
  promoFullBalancePayment,
  promoMonthlyChunkAt,
  promoScheduledPayments,
  promoWhatIf,
  statementCashDueCents,
} from "@/lib/credit-cards";
import { todayIso } from "@/lib/dates";
import { cn } from "@/lib/cn";
import type {
  CreditCardPromoRow,
  CreditCardRow,
  CreditCardStatementRow,
} from "@/lib/db/schema";

export type PromoScheduledPayment = {
  id: string;
  dueDate: string;
  amountCents: number;
  note: string | null;
};

type StatementCycleMode = "calendar_day" | "interval_days";

// ─────────────────────────────────────────────────────────────────────────────
// Card create/edit dialog
// ─────────────────────────────────────────────────────────────────────────────

export function CardDialog({
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

export function StatementCreateDialog({
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

export function StatementEditDialog({
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

// ─────────────────────────────────────────────────────────────────────────────
// Promo create/edit dialog
// ─────────────────────────────────────────────────────────────────────────────

export function PromoDialog({
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

export function PromoWhatIfSheet({
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

export function PromoScheduleSheet({
  card,
  promo,
  initialPayments,
  scheduledCardPaymentCents = 0,
  onClose,
  onSaved,
}: {
  card: CreditCardRow;
  promo: CreditCardPromoRow;
  initialPayments: PromoScheduledPayment[];
  /** Pending calendar paydowns on this card that already credit the promo balance. */
  scheduledCardPaymentCents?: number;
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
  // Quick "add a payment" inputs — the primary way to schedule one payment at a
  // time. Amount defaults to whatever is still unscheduled so the user never
  // double-counts money that's already planned.
  const [quickDate, setQuickDate] = React.useState<string>(today);
  const [quickAmountCents, setQuickAmountCents] = React.useState<number>(() => {
    const scheduled = initialPayments.reduce((s, p) => s + p.amountCents, 0);
    return Math.max(0, promo.remainingAmountCents - scheduled);
  });

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
  const gap = remaining - totalScheduled; // positive: unscheduled, negative: over
  // What's left to schedule after existing payments. Feeds the quick-add form
  // and the summary so adding a payment always accounts for prior ones.
  const leftToSchedule = Math.max(0, gap);

  const addQuickPayment = () => {
    if (!quickDate) {
      toast.error("Pick a payment date");
      return;
    }
    if (quickDate > promo.endDate) {
      toast.error(`Payment must be on or before ${promo.endDate}`);
      return;
    }
    if (quickAmountCents <= 0) {
      toast.error("Enter a positive amount");
      return;
    }
    if (totalScheduled + quickAmountCents > remaining) {
      toast.error("That exceeds the remaining balance — reduce the amount");
      return;
    }
    setDrafts((d) => [
      ...d,
      { key: makeDraftKey(), dueDate: quickDate, amountCents: quickAmountCents, note: null },
    ]);
    // Re-default the amount to whatever is still unscheduled after this add.
    setQuickAmountCents(Math.max(0, remaining - totalScheduled - quickAmountCents));
  };

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

  const planFullBalance = () => {
    if (promo.endDate < today) {
      toast.error("This deadline has passed — reconcile the actual PayPal balance first");
      return;
    }
    setDrafts(
      promoFullBalancePayment(promo).map((payment) => ({
        key: makeDraftKey(),
        dueDate: payment.dueDate,
        amountCents: payment.amountCents,
        note: "Full promotional balance by deadline",
      })),
    );
  };

  const planMonthlyPayments = () => {
    if (promo.endDate < today) {
      toast.error("This deadline has passed — reconcile the actual PayPal balance first");
      return;
    }
    const schedule = promoScheduledPayments(promo, card, today);
    setDrafts(
      schedule.map((payment) => ({
        key: makeDraftKey(),
        dueDate: payment.dueDate,
        amountCents: payment.amountCents,
        note: "Scheduled promotional payoff",
      })),
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
    if (gap < 0) {
      toast.error("Schedule exceeds the remaining balance — remove or lower a payment");
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
            Add payments one at a time up to the remaining balance. Anything you
            leave unscheduled auto-spreads across future cycles (or lands on the
            deadline). Actual balances change only when reconciled.
          </div>

          {scheduledCardPaymentCents > 0 ? (
            <div className="rounded-sm border border-[var(--cyan)]/40 bg-[var(--cyan)]/5 p-3 text-[11px] leading-relaxed text-[var(--text-2)]">
              This card already has{" "}
              <span className="font-semibold tabular text-[var(--text-0)]">
                <Money cents={scheduledCardPaymentCents} />
              </span>{" "}
              of card payments scheduled on the calendar, and those are applied to its promo
              balance. Payments you plan here may be covered by them and won&apos;t appear
              separately on the calendar.
            </div>
          ) : null}

          {/* Quick add — schedule a single payment; amount defaults to what's
              left so previous payments are never double-counted. */}
          <div className="space-y-2 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-1)] p-3">
            <div className="flex items-baseline justify-between text-[10px] uppercase tracking-[0.14em] text-[var(--text-3)]">
              <span>ADD A PAYMENT</span>
              <span>
                LEFT TO SCHEDULE{" "}
                <span
                  className={cn(
                    "font-bold tabular",
                    leftToSchedule > 0 ? "text-[var(--amber)]" : "text-[var(--phosphor)]",
                  )}
                >
                  <Money cents={leftToSchedule} />
                </span>
              </span>
            </div>
            <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="promo-quick-date" className="text-[9px]">
                  DATE
                </Label>
                <Input
                  id="promo-quick-date"
                  type="date"
                  min={today}
                  max={promo.endDate}
                  value={quickDate}
                  onChange={(e) => setQuickDate(e.target.value)}
                  className="h-8 text-[11px]"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="promo-quick-amount" className="text-[9px]">
                  AMOUNT
                </Label>
                <MoneyInput
                  id="promo-quick-amount"
                  valueCents={quickAmountCents}
                  onChangeCents={setQuickAmountCents}
                />
              </div>
              <Button
                size="sm"
                variant="primary"
                onClick={addQuickPayment}
                disabled={quickAmountCents <= 0 || !quickDate || leftToSchedule <= 0}
                title={leftToSchedule <= 0 ? "Fully scheduled" : "Add this payment"}
              >
                <Plus className="h-3 w-3" /> ADD
              </Button>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={planFullBalance}
              disabled={promo.endDate < today}
              className="border border-[var(--border-raw)] bg-[var(--bg-1)] p-3 text-left transition-colors hover:border-[var(--cyan)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--cyan)]">
                PAY FULL BY DEADLINE
              </div>
              <div className="mt-1 text-[16px] font-bold tabular text-[var(--text-0)]">
                <Money cents={remaining} />
              </div>
              <div className="mt-1 text-[10px] text-[var(--text-2)]">
                One planned payment on <DateLabel iso={promo.endDate} format="short" />.
              </div>
            </button>
            <button
              type="button"
              onClick={planMonthlyPayments}
              disabled={promo.endDate < today}
              className="border border-[var(--border-raw)] bg-[var(--bg-1)] p-3 text-left transition-colors hover:border-[var(--cyan)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--cyan)]">
                SCHEDULE THROUGH PROMO
              </div>
              <div className="mt-1 text-[16px] font-bold tabular text-[var(--text-0)]">
                MONTHLY
              </div>
              <div className="mt-1 text-[10px] text-[var(--text-2)]">
                Auto-fill card-cycle payments through the promotional deadline.
              </div>
            </button>
          </div>

          {sorted.length === 0 ? (
            <div className="rounded-sm border border-dashed border-[var(--border-raw)] bg-[var(--bg-2)] p-4 text-center text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">
              NO MANUAL PAYMENTS — PROMO USES AUTO-SPREAD
              <div className="mt-1 lowercase tracking-normal">
                add a payment above, or use a preset, to plan it yourself
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
                    UNSCHEDULED <Money cents={gap} />
                  </>
                ) : gap < 0 ? (
                  <>
                    OVER <Money cents={-gap} />
                  </>
                ) : (
                  "FULLY SCHEDULED"
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
