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
import { MoneyInput } from "@/components/money-input";
import { Money } from "@/components/money";
import type { PlaidTransactionDraftRow } from "@/lib/db/schema";

interface PlaidDraftApproveDialogProps {
  draft: PlaidTransactionDraftRow & { accountName: string; accountMask: string | null };
  categories: string[];
  onClose: () => void;
  onApproved: () => void;
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
  const [saving, setSaving] = React.useState(false);

  const matchedCategory =
    categories.find((c) => c.toLowerCase() === category.toLowerCase()) ??
    categories[0] ??
    "Other";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`/api/plaid/drafts/${draft.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "approve",
          date,
          description: description.trim(),
          amountCents,
          category: matchedCategory,
          notes: notes.trim() || null,
        }),
      });
      const json = await res.json() as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Approve failed");
      toast.success("Transaction approved and added to one-time expenses");
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
        </div>

        <form onSubmit={submit} className="space-y-4 pt-1">
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
            <Button type="submit" variant="primary" disabled={saving || !description.trim()}>
              {saving ? "APPROVING…" : "APPROVE & ADD"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
