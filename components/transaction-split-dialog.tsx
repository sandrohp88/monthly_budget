"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CardSubTag } from "@/components/ui/page-head";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/money-input";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import { cn } from "@/lib/cn";
import { daysBetween } from "@/lib/dates";
import { MATCH_WINDOW_DAYS, enumerateBillOccurrences } from "@/lib/bill-reconciliation";

export type SplitBillOption = {
  id: string;
  name: string;
  amountCents: number;
  intervalMonths: number;
  anchorDate: string;
};

export type SplitExtraOption = {
  id: string;
  description: string;
  date: string;
  amountCents: number;
};

export type Allocation = {
  targetKind: "bill" | "extra" | "card_payment";
  targetId: string;
  targetDate: string;
  amountCents: number;
};

/** One obligation the transaction could have paid: a dated, planned amount. */
type Candidate = {
  key: string;
  targetKind: "bill" | "extra" | "card_payment";
  targetId: string;
  targetDate: string;
  label: string;
  plannedCents: number;
  distanceDays: number;
};

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Obligations near the transaction's date, nearest first. Bill occurrences are
 * enumerated with the same pure helper the server matcher uses, so the choices
 * on screen are exactly the ones reconciliation can settle.
 */
function candidatesFor(
  txnDate: string,
  bills: ReadonlyArray<SplitBillOption>,
  extras: ReadonlyArray<SplitExtraOption>,
  cardPayments: ReadonlyArray<SplitExtraOption>,
): Candidate[] {
  const from = addDays(txnDate, -MATCH_WINDOW_DAYS);
  const to = addDays(txnDate, MATCH_WINDOW_DAYS);
  const out: Candidate[] = [];

  for (const b of bills) {
    for (const date of enumerateBillOccurrences(b, from, to)) {
      out.push({
        key: `bill:${b.id}:${date}`,
        targetKind: "bill",
        targetId: b.id,
        targetDate: date,
        label: b.name,
        plannedCents: b.amountCents,
        distanceDays: Math.abs(daysBetween(date, txnDate)),
      });
    }
  }
  for (const e of extras) {
    if (e.date < from || e.date > to) continue;
    out.push({
      key: `extra:${e.id}:${e.date}`,
      targetKind: "extra",
      targetId: e.id,
      targetDate: e.date,
      label: e.description,
      plannedCents: e.amountCents,
      distanceDays: Math.abs(daysBetween(e.date, txnDate)),
    });
  }
  for (const p of cardPayments) {
    // All saved plans stay selectable, even if posting was very late.
    out.push({
      key: `card_payment:${p.id}:${p.date}`,
      targetKind: "card_payment",
      targetId: p.id,
      targetDate: p.date,
      label: p.description,
      plannedCents: p.amountCents,
      distanceDays: Math.abs(daysBetween(p.date, txnDate)),
    });
  }
  out.sort((a, b) => a.distanceDays - b.distanceDays || a.label.localeCompare(b.label));
  return out;
}

/**
 * Divide one transaction across the obligations it actually paid.
 *
 * The matcher can credit a transaction to exactly one occurrence, which is
 * right until a single transfer covers two things at once — and no heuristic
 * can recover that split, because only the person who sent the money knows how
 * it divides. This dialog takes the answer directly.
 */
export function TransactionSplitDialog({
  transactionId,
  transactionDate,
  transactionLabel,
  transactionAmountCents,
  initialAllocations,
  bills,
  extras,
  cardPayments = [],
  onClose,
}: {
  transactionId: string;
  transactionDate: string;
  transactionLabel: string;
  /** Positive cents — the debit being divided. */
  transactionAmountCents: number;
  initialAllocations: ReadonlyArray<Allocation>;
  bills: ReadonlyArray<SplitBillOption>;
  extras: ReadonlyArray<SplitExtraOption>;
  cardPayments?: ReadonlyArray<SplitExtraOption>;
  onClose: () => void;
}) {
  const router = useRouter();
  const [saving, setSaving] = React.useState(false);
  const candidates = React.useMemo(
    () => candidatesFor(transactionDate, bills, extras, cardPayments),
    [transactionDate, bills, extras, cardPayments],
  );

  // Selected portions, keyed by candidate key. Absent = not part of the split.
  const [amounts, setAmounts] = React.useState<Record<string, number>>(() => {
    const seed: Record<string, number> = {};
    for (const a of initialAllocations) {
      seed[`${a.targetKind}:${a.targetId}:${a.targetDate}`] = a.amountCents;
    }
    return seed;
  });

  const allocatedCents = Object.values(amounts).reduce((s, n) => s + n, 0);
  const remainderCents = transactionAmountCents - allocatedCents;
  const overAllocated = remainderCents < 0;

  const toggle = (c: Candidate) => {
    setAmounts((prev) => {
      if (c.key in prev) {
        const next = { ...prev };
        delete next[c.key];
        return next;
      }
      // Default to whichever is smaller: what this obligation expects, or
      // what's still unattributed — so adding a target never over-allocates.
      const suggested = Math.max(0, Math.min(c.plannedCents, remainderCents));
      return { ...prev, [c.key]: suggested };
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const allocations = candidates
        .filter((c) => c.key in amounts && amounts[c.key]! > 0)
        .map((c) => ({
          targetKind: c.targetKind,
          targetId: c.targetId,
          targetDate: c.targetDate,
          amountCents: amounts[c.key]!,
        }));
      const res = await fetch(`/api/plaid/drafts/${transactionId}/allocations`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allocations }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not save the split");
      toast.success(
        allocations.length === 0
          ? "Split cleared — back to automatic matching"
          : `Split across ${allocations.length} ${allocations.length === 1 ? "item" : "items"}`,
      );
      router.refresh();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <CardSubTag>Split transaction</CardSubTag>
          <DialogTitle>What did this pay?</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 py-2 text-[13px]">
            <div className="font-semibold text-[var(--text-0)]">{transactionLabel}</div>
            <div className="text-2xs mt-0.5 text-[var(--text-3)]">
              <DateLabel iso={transactionDate} format="short" /> ·{" "}
              <Money cents={transactionAmountCents} />
            </div>
          </div>

          {candidates.length === 0 ? (
            <p className="text-[13px] text-[var(--text-2)]">
              No bills or one-time expenses fall within {MATCH_WINDOW_DAYS} days of this
              transaction, so there is nothing to split it across.
            </p>
          ) : (
            <div className="space-y-2">
              <Label>Pick what it covered</Label>
              <div className="space-y-1.5">
                {candidates.map((c) => {
                  const selected = c.key in amounts;
                  return (
                    <div
                      key={c.key}
                      className={cn(
                        "rounded-md border px-3 py-2 transition-colors",
                        selected
                          ? "border-[var(--mint)] bg-[var(--mint-glow)]"
                          : "border-[var(--border-raw)]",
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <button
                          type="button"
                          className="min-w-0 flex-1 cursor-pointer text-left"
                          onClick={() => toggle(c)}
                        >
                          <div className="truncate text-[13px] font-semibold text-[var(--text-0)]">
                            {c.label}
                          </div>
                          <div className="text-2xs text-[var(--text-3)]">
                            {c.targetKind === "bill"
                              ? "Bill"
                              : c.targetKind === "card_payment"
                                ? "Card payment"
                                : "One-time"}{" "}
                            · due <DateLabel iso={c.targetDate} format="short" /> · plan{" "}
                            <Money cents={c.plannedCents} />
                          </div>
                        </button>
                        {selected ? (
                          <div className="w-32 shrink-0">
                            <MoneyInput
                              valueCents={amounts[c.key] ?? 0}
                              onChangeCents={(v) =>
                                setAmounts((prev) => ({ ...prev, [c.key]: Math.max(0, v) }))
                              }
                            />
                          </div>
                        ) : (
                          <Button size="sm" variant="outline" onClick={() => toggle(c)}>
                            Add
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div
            className={cn(
              "flex items-center justify-between rounded-md border px-3 py-2 text-[13px]",
              overAllocated
                ? "border-[var(--red)]/50 bg-[var(--red)]/10 text-[var(--red)]"
                : "border-[var(--border-raw)] text-[var(--text-2)]",
            )}
          >
            <span>{overAllocated ? "Over-allocated by" : "Not yet attributed"}</span>
            <span className="tabular font-semibold">
              <Money cents={Math.abs(remainderCents)} />
            </span>
          </div>

          <p className="text-2xs leading-relaxed text-[var(--text-3)]">
            Splitting takes this transaction out of automatic matching — the portions below are what
            counts. Leaving some unattributed is fine; that part simply doesn&apos;t settle
            anything. Any bill you name here also learns this wording for future months.
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={save} disabled={saving || overAllocated}>
            {saving ? "Saving…" : "Save split"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
