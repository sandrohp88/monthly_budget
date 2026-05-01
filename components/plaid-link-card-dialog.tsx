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
import type { PlaidAccountRow, CreditCardRow } from "@/lib/db/schema";

interface PlaidLinkCardDialogProps {
  /** The Plaid account being linked. */
  account: PlaidAccountRow;
  /** All of the user's manual cards. Already-linked cards are filtered out for the picker. */
  cards: CreditCardRow[];
  onClose: () => void;
  onLinked: () => void;
}

/**
 * Two modes:
 * - "existing": pick an unlinked manual card and attach this Plaid account to it
 * - "new": create a new card from this account (name pre-filled from Plaid)
 *
 * On save, calls POST /api/plaid/accounts/[id]/link-card. The server
 * immediately runs Liabilities for this item so cycle days + statement land
 * before the dialog closes.
 */
export function PlaidLinkCardDialog({
  account,
  cards,
  onClose,
  onLinked,
}: PlaidLinkCardDialogProps) {
  const unlinkedCards = cards.filter((c) => c.plaidAccountId == null);

  // Default to "existing" if any unlinked manual cards exist; otherwise "new".
  const [mode, setMode] = React.useState<"existing" | "new">(
    unlinkedCards.length > 0 ? "existing" : "new",
  );
  const [selectedCardId, setSelectedCardId] = React.useState<string>(
    unlinkedCards[0]?.id ?? "",
  );
  const defaultName =
    account.name + (account.mask ? ` ****${account.mask}` : "");
  const [newName, setNewName] = React.useState(defaultName);
  const [saving, setSaving] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body =
        mode === "existing"
          ? { creditCardId: selectedCardId }
          : { createNew: { name: newName.trim() } };

      const res = await fetch(`/api/plaid/accounts/${account.id}/link-card`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; card?: { name: string } };
      if (!res.ok) throw new Error(json.error ?? "Link failed");

      toast.success(
        mode === "new"
          ? `Created and linked "${json.card?.name ?? newName}"`
          : `Linked to "${json.card?.name ?? "card"}"`,
      );
      onLinked();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <CardSubTag>LINK_CARD</CardSubTag>
            <DialogTitle>LINK CREDIT CARD</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-1)] px-3 py-2 text-[11px]">
              <div className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-3)]">
                PLAID ACCOUNT
              </div>
              <div className="font-semibold uppercase tracking-[0.08em] text-[var(--text-0)]">
                {account.name}
                {account.mask ? (
                  <span className="ml-2 text-[var(--text-3)]">****{account.mask}</span>
                ) : null}
              </div>
            </div>

            {/* Mode toggle */}
            <div className="flex gap-1 border-b border-[var(--border-raw)]">
              <button
                type="button"
                onClick={() => setMode("existing")}
                disabled={unlinkedCards.length === 0}
                className={[
                  "px-3 py-1.5 text-[10px] uppercase tracking-[0.15em] border-b-2 -mb-px transition-colors",
                  mode === "existing"
                    ? "border-[var(--mint)] text-[var(--mint)]"
                    : "border-transparent text-[var(--text-2)] hover:text-[var(--text-1)]",
                  unlinkedCards.length === 0 && "opacity-40 cursor-not-allowed",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                LINK EXISTING
              </button>
              <button
                type="button"
                onClick={() => setMode("new")}
                className={[
                  "px-3 py-1.5 text-[10px] uppercase tracking-[0.15em] border-b-2 -mb-px transition-colors",
                  mode === "new"
                    ? "border-[var(--mint)] text-[var(--mint)]"
                    : "border-transparent text-[var(--text-2)] hover:text-[var(--text-1)]",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                CREATE NEW
              </button>
            </div>

            {mode === "existing" ? (
              <div className="space-y-2">
                <Label>SELECT CARD</Label>
                {unlinkedCards.length === 0 ? (
                  <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">
                    No unlinked manual cards available.
                  </div>
                ) : (
                  <select
                    id="link-card-select"
                    value={selectedCardId}
                    onChange={(e) => setSelectedCardId(e.target.value)}
                    className="w-full rounded-sm border border-[var(--border-raw)] bg-[var(--bg-1)] px-3 py-2 text-[12px] uppercase tracking-[0.08em] text-[var(--text-0)] focus:border-[var(--mint)] focus:outline-none"
                  >
                    {unlinkedCards.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                )}
                <p className="text-[10px] tracking-wide text-[var(--text-3)]">
                  Cycle days + most recent statement will be pulled from Plaid
                  immediately.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="link-card-new-name">CARD NAME</Label>
                <Input
                  id="link-card-new-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  required
                  maxLength={80}
                  autoFocus
                />
                <p className="text-[10px] tracking-wide text-[var(--text-3)]">
                  A new credit card will be created and linked. Cycle days are
                  populated from Plaid Liabilities right away.
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              CANCEL
            </Button>
            <Button
              id="link-card-submit"
              type="submit"
              variant="primary"
              disabled={
                saving ||
                (mode === "existing" && !selectedCardId) ||
                (mode === "new" && newName.trim().length === 0)
              }
            >
              {saving ? "LINKING…" : "LINK"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
