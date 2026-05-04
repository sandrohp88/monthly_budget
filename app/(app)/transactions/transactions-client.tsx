"use client";

import * as React from "react";
import { Pencil, RefreshCw, Search, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { CardSubTag, PageHead } from "@/components/ui/page-head";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/money";
import { MoneyInput } from "@/components/money-input";
import { DateLabel } from "@/components/date-label";
import { StatusPill } from "@/components/ui/status-pill";
import { Switch } from "@/components/ui/switch";
import { Tile, TileGrid } from "@/components/ui/tile";
import { cn } from "@/lib/cn";
import type { DraftWithAccount } from "@/app/api/plaid/drafts/route";

type FilterKey = "all" | "debits" | "credits" | "promos";

function addMonthsIso(iso: string, months: number): string {
  const parts = iso.split("-").map(Number);
  const year = parts[0] ?? new Date().getUTCFullYear();
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

function displayName(txn: DraftWithAccount): string {
  return txn.merchantName ?? txn.description;
}

function isPromoCandidate(txn: DraftWithAccount): boolean {
  return txn.amountCents >= 150_00 && txn.linkedCreditCardId !== null && !txn.linkedPromoId;
}

export function TransactionsClient({
  initialTransactions,
  categoryNames,
}: {
  initialTransactions: DraftWithAccount[];
  categoryNames: string[];
}) {
  const [transactions, setTransactions] = React.useState(initialTransactions);
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<FilterKey>("all");
  const [syncing, setSyncing] = React.useState(false);
  const [editing, setEditing] = React.useState<DraftWithAccount | null>(null);
  const [promoTxn, setPromoTxn] = React.useState<DraftWithAccount | null>(null);

  const refresh = React.useCallback(async () => {
    const res = await fetch("/api/plaid/drafts?status=approved");
    if (!res.ok) return;
    const json = (await res.json()) as { drafts: DraftWithAccount[] };
    setTransactions(json.drafts);
  }, []);

  const sync = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/plaid/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = (await res.json()) as { added?: number; modified?: number; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Sync failed");
      toast.success(`Sync complete - ${json.added ?? 0} new, ${json.modified ?? 0} updated`);
      await refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const remove = async (txn: DraftWithAccount) => {
    if (!confirm(`Delete ${displayName(txn)}?`)) return;
    const previous = transactions;
    setTransactions((rows) => rows.filter((r) => r.id !== txn.id));
    try {
      const res = await fetch(`/api/plaid/drafts/${txn.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      toast.success("Transaction deleted");
    } catch (err) {
      setTransactions(previous);
      toast.error((err as Error).message);
    }
  };

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return transactions.filter((txn) => {
      if (filter === "debits" && txn.amountCents <= 0) return false;
      if (filter === "credits" && txn.amountCents >= 0) return false;
      if (filter === "promos" && !isPromoCandidate(txn) && !txn.linkedPromoId) return false;
      if (!q) return true;
      return [
        txn.description,
        txn.originalDescription,
        txn.merchantName,
        txn.accountName,
        txn.plaidCategory,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [filter, query, transactions]);

  const debits = transactions.filter((txn) => txn.amountCents > 0);
  const credits = transactions.filter((txn) => txn.amountCents < 0);
  const promoCandidates = transactions.filter(isPromoCandidate);

  return (
    <div className="space-y-6 fade-in">
      <PageHead
        module="MODULE_09"
        title="TRANSACTIONS"
        subtitle="Linked account transaction history"
        actions={
          <Button variant="outline" onClick={sync} disabled={syncing}>
            <RefreshCw className={cn("h-3 w-3", syncing && "animate-spin")} />
            {syncing ? "SYNCING..." : "SYNC NOW"}
          </Button>
        }
      />

      <TileGrid cols="auto">
        <Tile label="IMPORTED" value={transactions.length} delta="approved automatically" />
        <Tile label="DEBITS" value={debits.length} delta={<Money cents={debits.reduce((s, t) => s + t.amountCents, 0)} />} />
        <Tile label="CREDITS" value={credits.length} delta={<Money cents={Math.abs(credits.reduce((s, t) => s + t.amountCents, 0))} />} />
        <Tile label="PROMO CANDIDATES" value={promoCandidates.length} variant={promoCandidates.length ? "amber" : "default"} delta="linked card purchases >= $150" />
      </TileGrid>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {(["all", "debits", "credits", "promos"] as const).map((key) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={cn(
                "rounded-sm border px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] transition-colors",
                filter === key
                  ? "border-[var(--mint-dim)] bg-[var(--mint-glow)] text-[var(--mint)]"
                  : "border-[var(--border-raw)] bg-[var(--bg-2)] text-[var(--text-2)] hover:text-[var(--text-0)]",
              )}
            >
              {key}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-80">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-3.5 w-3.5 text-[var(--text-3)]" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
            placeholder="search"
          />
        </div>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardSubTag>TRANSACTION_LEDGER</CardSubTag>
            <CardTitle className="mt-0.5">HISTORY</CardTitle>
          </div>
        </CardHeader>
        {visible.length === 0 ? (
          <div className="px-4 py-10 text-center text-[11px] uppercase tracking-[0.15em] text-[var(--text-3)]">
            NO TRANSACTIONS
          </div>
        ) : (
          <div className="divide-y divide-[var(--border-raw)]">
            {visible.map((txn) => {
              const isCredit = txn.amountCents < 0;
              return (
                <div
                  key={txn.id}
                  className="grid grid-cols-[88px_1fr_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--bg-2)] lg:grid-cols-[88px_1fr_150px_130px_auto]"
                >
                  <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-2)]">
                    <DateLabel iso={txn.date} format="short" />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-0)]">
                      {displayName(txn)}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[9px] uppercase tracking-[0.1em] text-[var(--text-3)]">
                      <span>{txn.accountName}{txn.accountMask ? ` ****${txn.accountMask}` : ""}</span>
                      {txn.linkedCreditCardName ? <span className="text-[var(--mint)]">· {txn.linkedCreditCardName}</span> : null}
                      {txn.plaidCategory ? <span>· {txn.plaidCategory}</span> : null}
                      {txn.promoPayoffDate ? (
                        <StatusPill variant="amber">PAYOFF <DateLabel iso={txn.promoPayoffDate} format="short" /></StatusPill>
                      ) : null}
                      {txn.linkedPromoId ? <StatusPill>PROMO</StatusPill> : null}
                    </div>
                    {txn.originalDescription ? (
                      <div className="mt-1 truncate text-[9px] tracking-wide text-[var(--text-3)]">
                        {txn.originalDescription}
                      </div>
                    ) : null}
                  </div>
                  <div className={cn("text-right text-[14px] font-bold tabular", isCredit ? "text-[var(--mint)]" : "text-[var(--red)]")}>
                    {isCredit ? "+" : "-"}<Money cents={Math.abs(txn.amountCents)} />
                  </div>
                  <div className="hidden justify-end lg:flex">
                    {isPromoCandidate(txn) ? (
                      <Button size="sm" variant="outline" onClick={() => setPromoTxn(txn)}>
                        <Sparkles className="h-3 w-3" /> PROMO
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex justify-end gap-1">
                    <Button size="icon" variant="ghost" aria-label="Edit" onClick={() => setEditing(txn)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" aria-label="Delete" onClick={() => remove(txn)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {editing ? (
        <TransactionEditDialog
          transaction={editing}
          categories={categoryNames}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setTransactions((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
            setEditing(null);
          }}
        />
      ) : null}

      {promoTxn ? (
        <TransactionPromoDialog
          transaction={promoTxn}
          onClose={() => setPromoTxn(null)}
          onSaved={(updated) => {
            setTransactions((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
            setPromoTxn(null);
          }}
        />
      ) : null}
    </div>
  );
}

function TransactionEditDialog({
  transaction,
  categories,
  onClose,
  onSaved,
}: {
  transaction: DraftWithAccount;
  categories: string[];
  onClose: () => void;
  onSaved: (updated: DraftWithAccount) => void;
}) {
  const [date, setDate] = React.useState(transaction.date);
  const [description, setDescription] = React.useState(displayName(transaction));
  const [amountCents, setAmountCents] = React.useState(Math.abs(transaction.amountCents));
  const [isCredit, setIsCredit] = React.useState(transaction.amountCents < 0);
  const [category, setCategory] = React.useState(transaction.plaidCategory ?? categories[0] ?? "Other");
  const [saving, setSaving] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const signedAmount = isCredit ? -Math.abs(amountCents) : Math.abs(amountCents);
      const res = await fetch(`/api/plaid/drafts/${transaction.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "update_transaction",
          date,
          description: description.trim(),
          amountCents: signedAmount,
          category,
        }),
      });
      const json = (await res.json()) as { draft?: DraftWithAccount; error?: string };
      if (!res.ok || !json.draft) throw new Error(json.error ?? "Save failed");
      toast.success("Transaction updated");
      onSaved({ ...transaction, ...json.draft });
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
          <CardSubTag>TRANSACTION</CardSubTag>
          <DialogTitle>EDIT TRANSACTION</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="txn-date">DATE</Label>
              <Input id="txn-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>AMOUNT</Label>
              <MoneyInput valueCents={amountCents} onChangeCents={setAmountCents} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="txn-desc">DESCRIPTION</Label>
            <Input id="txn-desc" required maxLength={120} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <label className="flex cursor-pointer items-center justify-between rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-1)]">CREDIT / REFUND</span>
            <Switch checked={isCredit} onCheckedChange={setIsCredit} />
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="txn-category">CATEGORY</Label>
            <select
              id="txn-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-sm border border-[var(--border-2)] bg-[var(--bg-1)] px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-[var(--text-0)] focus:outline-none focus:ring-1 focus:ring-[var(--mint)]"
            >
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>CANCEL</Button>
            <Button type="submit" variant="primary" disabled={saving || !description.trim() || amountCents < 0}>
              {saving ? "SAVING..." : "SAVE"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TransactionPromoDialog({
  transaction,
  onClose,
  onSaved,
}: {
  transaction: DraftWithAccount;
  onClose: () => void;
  onSaved: (updated: DraftWithAccount) => void;
}) {
  const [description, setDescription] = React.useState(displayName(transaction));
  const [originalAmountCents, setOriginalAmountCents] = React.useState(Math.abs(transaction.amountCents));
  const [remainingAmountCents, setRemainingAmountCents] = React.useState(Math.abs(transaction.amountCents));
  const [startDate, setStartDate] = React.useState(transaction.date);
  const [endDate, setEndDate] = React.useState(transaction.promoPayoffDate ?? addMonthsIso(transaction.date, 6));
  const [useDesiredPayment, setUseDesiredPayment] = React.useState(false);
  const [monthlyPaymentCents, setMonthlyPaymentCents] = React.useState(0);
  const [saving, setSaving] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`/api/plaid/drafts/${transaction.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create_promo",
          cardId: transaction.linkedCreditCardId,
          description: description.trim(),
          originalAmountCents,
          remainingAmountCents,
          startDate,
          endDate,
          monthlyPaymentCents: useDesiredPayment ? monthlyPaymentCents : null,
          notes: transaction.originalDescription ?? null,
        }),
      });
      const json = (await res.json()) as { draft?: DraftWithAccount; error?: string };
      if (!res.ok || !json.draft) throw new Error(json.error ?? "Promo failed");
      toast.success("Promo created");
      onSaved({ ...transaction, ...json.draft });
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
          <CardSubTag>{transaction.linkedCreditCardName ?? "LINKED CARD"}</CardSubTag>
          <DialogTitle>CREATE PROMO</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="promo-start">PURCHASE DATE</Label>
              <Input id="promo-start" type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="promo-end">PAY IN FULL BY</Label>
              <Input id="promo-end" type="date" required value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="promo-desc">DESCRIPTION</Label>
            <Input id="promo-desc" required maxLength={120} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>ORIGINAL AMOUNT</Label>
              <MoneyInput valueCents={originalAmountCents} onChangeCents={(next) => {
                setOriginalAmountCents(next);
                setRemainingAmountCents((current) => Math.min(current, next));
              }} />
            </div>
            <div className="space-y-1.5">
              <Label>REMAINING BALANCE</Label>
              <MoneyInput valueCents={remainingAmountCents} onChangeCents={setRemainingAmountCents} />
            </div>
          </div>
          <label className="flex cursor-pointer items-center justify-between rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-1)]">SET DESIRED CYCLE PAYMENT</span>
            <Switch checked={useDesiredPayment} onCheckedChange={setUseDesiredPayment} />
          </label>
          {useDesiredPayment ? (
            <div className="space-y-1.5">
              <Label>DESIRED CYCLE PAYMENT</Label>
              <MoneyInput valueCents={monthlyPaymentCents} onChangeCents={setMonthlyPaymentCents} />
            </div>
          ) : null}
          {transaction.originalDescription ? (
            <div className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 py-2 text-[10px] tracking-wide text-[var(--text-2)]">
              {transaction.originalDescription}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>CANCEL</Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                saving ||
                !description.trim() ||
                originalAmountCents <= 0 ||
                remainingAmountCents < 0 ||
                remainingAmountCents > originalAmountCents ||
                (useDesiredPayment && monthlyPaymentCents <= 0)
              }
            >
              {saving ? "SAVING..." : "CREATE PROMO"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
