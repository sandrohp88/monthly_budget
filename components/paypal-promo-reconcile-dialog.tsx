"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CardSubTag } from "@/components/ui/page-head";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import {
  parsePayPalPromoList,
  planPromoReconcile,
  type MatchablePromo,
} from "@/lib/paypal-promo-list";

/**
 * Paste PayPal's "Promotional purchases" page → preview the diff against this
 * card's active promos → apply. The preview and the server share the same
 * parser/matcher (lib/paypal-promo-list.ts), so what's shown is what lands.
 */
export function PayPalPromoReconcileDialog({
  card,
  promos,
  onClose,
  onApplied,
}: {
  card: { id: string; name: string };
  promos: ReadonlyArray<MatchablePromo>;
  onClose: () => void;
  onApplied: () => void | Promise<void>;
}) {
  const [text, setText] = React.useState("");
  const [archiveMissing, setArchiveMissing] = React.useState(true);
  const [applying, setApplying] = React.useState(false);

  const rows = React.useMemo(() => parsePayPalPromoList(text), [text]);
  const plan = React.useMemo(() => planPromoReconcile(promos, rows), [promos, rows]);
  const promoById = React.useMemo(
    () => new Map(promos.map((p) => [p.id, p] as const)),
    [promos],
  );

  const apply = async () => {
    setApplying(true);
    try {
      const res = await fetch(`/api/credit-cards/${card.id}/promos/reconcile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows, archiveMissing }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "reconcile failed");
      toast.success(
        `Reconciled: ${json.updated} updated, ${json.created} created, ${json.archived} archived`,
      );
      await onApplied();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <CardSubTag>{`${card.name.toUpperCase()} // RECONCILE_PROMOS`}</CardSubTag>
          <DialogTitle>RECONCILE FROM PAYPAL LIST</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="promo-list-text">PASTE PAYPAL&apos;S PROMOTIONAL PURCHASES PAGE</Label>
            <textarea
              id="promo-list-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              placeholder={"Whisker City\n$391.02\nNo interest if paid in full by Sep 21, 2026\n…"}
              className="w-full rounded-sm border border-[var(--border-raw)] bg-[var(--bg-1)] px-3 py-2 font-mono text-[12px] text-[var(--text-0)] outline-none focus:border-[var(--mint)]"
            />
            <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">
              Copy the whole promo section — merchant, balance, and payoff date per entry
            </p>
          </div>

          {text.trim() && rows.length === 0 ? (
            <p className="text-[12px] text-[var(--amber)]">
              Nothing parseable yet — each promo needs a name, a $ amount, and a payoff date.
            </p>
          ) : null}

          {rows.length > 0 ? (
            <div className="space-y-2 text-[12px]">
              {plan.updates.length > 0 ? (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-[0.15em] text-[var(--text-3)]">
                    {"// UPDATE"} ({plan.updates.length})
                  </div>
                  {plan.updates.map(({ promoId, row }) => {
                    const existing = promoById.get(promoId);
                    return (
                      <div
                        key={promoId}
                        className="flex items-center justify-between gap-2 border border-[var(--border-raw)] bg-[var(--bg-2)] px-2 py-1.5"
                      >
                        <span className="min-w-0 truncate text-[var(--text-0)]">
                          {existing?.description}
                        </span>
                        <span className="tabular shrink-0 text-[var(--text-2)]">
                          <Money cents={existing?.remainingAmountCents ?? 0} /> →{" "}
                          <span className="text-[var(--mint)]">
                            <Money cents={row.remainingCents} />
                          </span>{" "}
                          · <DateLabel iso={row.endDate} format="short" />
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {plan.creates.length > 0 ? (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-[0.15em] text-[var(--text-3)]">
                    {"// CREATE"} ({plan.creates.length})
                  </div>
                  {plan.creates.map((row, i) => (
                    <div
                      key={`${row.description}-${i}`}
                      className="flex items-center justify-between gap-2 border border-[var(--mint-dim)] bg-[var(--mint-glow)] px-2 py-1.5"
                    >
                      <span className="min-w-0 truncate text-[var(--text-0)]">{row.description}</span>
                      <span className="tabular shrink-0 text-[var(--mint)]">
                        <Money cents={row.remainingCents} /> ·{" "}
                        <DateLabel iso={row.endDate} format="short" />
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              {plan.archives.length > 0 ? (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-[0.15em] text-[var(--text-3)]">
                    {"// NOT IN LIST"} ({plan.archives.length})
                  </div>
                  {plan.archives.map((a) => (
                    <div
                      key={a.promoId}
                      className="flex items-center justify-between gap-2 border border-[var(--border-raw)] bg-[var(--bg-2)] px-2 py-1.5"
                    >
                      <span className="min-w-0 truncate text-[var(--text-2)] line-through">
                        {a.description}
                      </span>
                      <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">
                        {archiveMissing ? "will archive (paid off)" : "kept as-is"}
                      </span>
                    </div>
                  ))}
                  <label className="mt-2 flex cursor-pointer items-center justify-between">
                    <Label>ARCHIVE PROMOS MISSING FROM THE LIST</Label>
                    <Switch checked={archiveMissing} onCheckedChange={setArchiveMissing} />
                  </label>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 pt-3">
          <Button variant="outline" onClick={onClose} disabled={applying}>
            CANCEL
          </Button>
          <Button
            variant="primary"
            onClick={apply}
            disabled={applying || rows.length === 0}
          >
            {applying ? "APPLYING…" : `APPLY ${rows.length} ROW${rows.length === 1 ? "" : "S"}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
