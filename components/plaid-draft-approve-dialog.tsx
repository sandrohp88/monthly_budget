"use client";

import * as React from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { MoneyInput } from "@/components/money-input";
import { Money } from "@/components/money";
import { cn } from "@/lib/cn";
import type { DraftWithAccount } from "@/app/api/plaid/drafts/route";

interface PlaidDraftApproveDialogProps {
  draft: DraftWithAccount;
  categories: string[];
  onClose: () => void;
  onApproved: () => void;
}

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

export function PlaidDraftApproveDialog({
  draft,
  categories,
  onClose,
  onApproved,
}: PlaidDraftApproveDialogProps) {
  const [date, setDate] = React.useState(draft.date);
  const [description, setDescription] = React.useState(
    draft.merchantName ?? draft.description,
  );
  const [amountCents, setAmountCents] = React.useState(
    Math.abs(draft.amountCents),
  );
  const [category, setCategory] = React.useState(
    draft.plaidCategory ?? "Other",
  );
  const [notes, setNotes] = React.useState("");
  const canCreatePromo = draft.linkedCreditCardId !== null && draft.amountCents > 0;
  const [mode, setMode] = React.useState<"expense" | "promo">(
    canCreatePromo ? "promo" : "expense",
  );
  const [promoStartDate, setPromoStartDate] = React.useState(draft.date);
  const [promoDescription, setPromoDescription] = React.useState(
    draft.merchantName ?? draft.description,
  );
  const [promoOriginalCents, setPromoOriginalCents] = React.useState(
    Math.abs(draft.amountCents),
  );
  const [promoRemainingCents, setPromoRemainingCents] = React.useState(
    Math.abs(draft.amountCents),
  );
  const [promoEndDate, setPromoEndDate] = React.useState(addMonthsIso(draft.date, 6));
  const [useDesiredPayment, setUseDesiredPayment] = React.useState(false);
  const [desiredPaymentCents, setDesiredPaymentCents] = React.useState(0);
  const [saving, setSaving] = React.useState(false);

  const matchedCategory =
    categories.find((c) => c.toLowerCase() === category.toLowerCase()) ??
    categories[0] ??
    "Other";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload =
        mode === "promo"
          ? {
              action: "create_promo",
              cardId: draft.linkedCreditCardId,
              description: promoDescription.trim(),
              originalAmountCents: promoOriginalCents,
              remainingAmountCents: promoRemainingCents,
              startDate: promoStartDate,
              endDate: promoEndDate,
              monthlyPaymentCents: useDesiredPayment ? desiredPaymentCents : null,
              notes: notes.trim() || null,
            }
          : {
              action: "approve",
              date,
              description: description.trim(),
              amountCents,
              category: matchedCategory,
              notes: notes.trim() || null,
            };
      const res = await fetch(`/api/plaid/drafts/${draft.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json() as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Approve failed");
      toast.success(
        mode === "promo"
          ? "Promo created from transaction"
          : "Transaction approved and added to one-time expenses",
      );
      onApproved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const isCredit = draft.amountCents < 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <CardSubTag>DRAFT_REVIEW</CardSubTag>
          <DialogTitle>APPROVE TRANSACTION</DialogTitle>
        </DialogHeader>

        {/* Source info */}
        <div className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 py-2 text-[10px] uppercase tracking-wide text-[var(--text-2)]">
          <span className="text-[var(--text-3)]">SOURCE: </span>
          {draft.accountName}
          {draft.accountMask ? ` ****${draft.accountMask}` : ""}
          <span className="ml-3 text-[var(--text-3)]">ORIGINAL: </span>
          <span className={isCredit ? "text-[var(--mint)]" : "text-[var(--red)]"}>
            <Money cents={Math.abs(draft.amountCents)} />
            {isCredit ? " CREDIT" : " DEBIT"}
          </span>
          {draft.linkedCreditCardName && (
            <>
              <span className="ml-3 text-[var(--text-3)]">CARD: </span>
              <span className="text-[var(--text-1)]">{draft.linkedCreditCardName}</span>
            </>
          )}
        </div>

        <form onSubmit={submit} className="space-y-4 pt-1">
          {canCreatePromo && (
            <div className="grid grid-cols-2 gap-1 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] p-1">
              <button
                type="button"
                onClick={() => setMode("promo")}
                className={cn(
                  "rounded-sm px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] transition-colors",
                  mode === "promo"
                    ? "bg-[var(--mint)] text-black"
                    : "text-[var(--text-2)] hover:text-[var(--text-0)]",
                )}
              >
                DEFERRED-INTEREST PROMO
              </button>
              <button
                type="button"
                onClick={() => setMode("expense")}
                className={cn(
                  "rounded-sm px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] transition-colors",
                  mode === "expense"
                    ? "bg-[var(--mint)] text-black"
                    : "text-[var(--text-2)] hover:text-[var(--text-0)]",
                )}
              >
                EXPENSE
              </button>
            </div>
          )}

          {mode === "expense" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="draft-date">DATE</Label>
                <Input
                  id="draft-date"
                  type="date"
                  required
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="draft-desc">DESCRIPTION</Label>
                <Input
                  id="draft-desc"
                  required
                  maxLength={120}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>AMOUNT</Label>
                <MoneyInput valueCents={amountCents} onChangeCents={setAmountCents} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="draft-cat">CATEGORY</Label>
                <select
                  id="draft-cat"
                  value={matchedCategory}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full rounded-sm border border-[var(--border-2)] bg-[var(--bg-1)] px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-[var(--text-0)] focus:outline-none focus:ring-1 focus:ring-[var(--mint)]"
                >
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="promo-start-date">PURCHASE DATE</Label>
                  <Input
                    id="promo-start-date"
                    type="date"
                    required
                    value={promoStartDate}
                    onChange={(e) => setPromoStartDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="promo-end-date">PAY IN FULL BY</Label>
                  <Input
                    id="promo-end-date"
                    type="date"
                    required
                    value={promoEndDate}
                    onChange={(e) => setPromoEndDate(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="promo-desc">DESCRIPTION</Label>
                <Input
                  id="promo-desc"
                  required
                  maxLength={120}
                  value={promoDescription}
                  onChange={(e) => setPromoDescription(e.target.value)}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>ORIGINAL AMOUNT</Label>
                  <MoneyInput
                    valueCents={promoOriginalCents}
                    onChangeCents={(next) => {
                      setPromoOriginalCents(next);
                      setPromoRemainingCents((current) => Math.min(current, next));
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>REMAINING BALANCE</Label>
                  <MoneyInput
                    valueCents={promoRemainingCents}
                    onChangeCents={setPromoRemainingCents}
                  />
                </div>
              </div>
              <label className="flex cursor-pointer items-center justify-between rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 py-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--text-1)]">
                  SET DESIRED CYCLE PAYMENT
                </span>
                <Switch checked={useDesiredPayment} onCheckedChange={setUseDesiredPayment} />
              </label>
              {useDesiredPayment && (
                <div className="space-y-1.5">
                  <Label>DESIRED CYCLE PAYMENT</Label>
                  <MoneyInput
                    valueCents={desiredPaymentCents}
                    onChangeCents={setDesiredPaymentCents}
                  />
                </div>
              )}
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="draft-notes">NOTES</Label>
            <Input
              id="draft-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="optional"
            />
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
                (mode === "expense" && !description.trim()) ||
                (mode === "promo" &&
                  (!promoDescription.trim() ||
                    promoOriginalCents <= 0 ||
                    promoRemainingCents < 0 ||
                    promoRemainingCents > promoOriginalCents ||
                    (useDesiredPayment && desiredPaymentCents <= 0) ||
                    !promoEndDate))
              }
            >
              {saving ? "SAVING…" : mode === "promo" ? "CREATE PROMO" : "APPROVE & ADD"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
