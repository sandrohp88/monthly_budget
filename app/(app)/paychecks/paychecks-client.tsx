"use client";

import * as React from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHead } from "@/components/ui/page-head";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/money-input";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import { Switch } from "@/components/ui/switch";
import { StatusPill } from "@/components/ui/status-pill";
import { AlertBar } from "@/components/ui/alert-bar";
import { Tile, TileGrid } from "@/components/ui/tile";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { todayIso } from "@/lib/dates";
import type { PaycheckRow } from "@/lib/db/schema";

export function PaychecksClient({
  initialPaychecks,
  timezone,
}: {
  initialPaychecks: PaycheckRow[];
  timezone: string;
}) {
  const [items, setItems] = React.useState<PaycheckRow[]>(initialPaychecks);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [regenPreview, setRegenPreview] = React.useState<{ payDate: string; amountCents: number }[] | null>(
    null,
  );
  const [submitting, setSubmitting] = React.useState(false);

  const today = todayIso(timezone);
  // Split on RECEIPT, not the scheduled date. Payroll often posts a day or two
  // ahead of payDate; such a paycheck is already reconciled (actualReceived)
  // while its payDate is still in the future. Keying on payDate alone stranded
  // it under "Upcoming" and hid it from the reconciliation ledger until its
  // scheduled date finally passed.
  const upcoming = items.filter((p) => p.payDate >= today && !p.actualReceived);
  const reconciled = items.filter((p) => p.actualReceived || p.payDate < today);
  const nextPayday = upcoming[0];

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "n") {
        e.preventDefault();
        setCreateOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const updateRow = async (row: PaycheckRow, patch: Partial<PaycheckRow>) => {
    const prev = items;
    // The server releases the auto-reconcile draft link when a row is
    // un-marked received — mirror that locally so the AUTO pill drops
    // immediately instead of waiting for a reload.
    if (patch.actualReceived === false) patch = { ...patch, settledByDraftId: null, actualDate: null };
    setItems((curr) => curr.map((p) => (p.id === row.id ? { ...p, ...patch } : p)));
    try {
      const res = await fetch(`/api/paychecks/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payDate: patch.payDate ?? row.payDate,
          amountCents: patch.amountCents ?? row.amountCents,
          note: (patch.note ?? row.note) ?? null,
          actualReceived: patch.actualReceived ?? row.actualReceived,
          actualAmountCents: patch.actualAmountCents ?? row.actualAmountCents,
        }),
      });
      if (!res.ok) throw new Error("update failed");
    } catch (e) {
      setItems(prev);
      toast.error((e as Error).message);
    }
  };

  const remove = async (id: string) => {
    const prev = items;
    setItems((curr) => curr.filter((p) => p.id !== id));
    try {
      const res = await fetch(`/api/paychecks/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      toast.success("Paycheck removed");
    } catch (e) {
      setItems(prev);
      toast.error((e as Error).message);
    }
  };

  const previewRegen = async () => {
    const res = await fetch("/api/paychecks", { method: "PUT" });
    const json = await res.json();
    setRegenPreview(json.preview ?? []);
  };

  const applyRegen = async () => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/paychecks?apply=true", { method: "PUT" });
      if (!res.ok) throw new Error("regenerate failed");
      const list = await fetch("/api/paychecks").then((r) => r.json());
      setItems(list.paychecks ?? []);
      setRegenPreview(null);
      toast.success("Paychecks regenerated");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 fade-in">
      <PageHead
        title="Paychecks"
        subtitle="Income schedule · scheduled and actual income reconciliation"
        actions={
          <>
            <Button variant="outline" onClick={previewRegen}>
              <RefreshCw className="h-3 w-3" /> Regen from settings
            </Button>
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3 w-3" /> Add paycheck
            </Button>
          </>
        }
      />

      <TileGrid cols={3}>
        <Tile
          label="Upcoming"
          value={upcoming.length}
          delta="paychecks scheduled"
        />
        <Tile
          label="Next payday"
          value={
            nextPayday ? (
              <DateLabel iso={nextPayday.payDate} format="short" />
            ) : (
              <span className="text-[var(--text-2)] text-base">—</span>
            )
          }
          delta={nextPayday ? <Money cents={nextPayday.amountCents} /> : "none"}
          variant="mint"
        />
        <Tile
          label="History"
          value={reconciled.length}
          delta="received"
        />
      </TileGrid>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No paychecks yet</CardTitle>
          </CardHeader>
          <div className="px-4 py-8 text-center">
            <p className="mb-4 text-[11px] tracking-wide text-[var(--text-2)]">
              Add a paycheck or regenerate from settings.
            </p>
          </div>
        </Card>
      ) : (
        <>
          {upcoming.length > 0 ? (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle className="mt-0.5">UPCOMING — NEXT {upcoming.length}</CardTitle>
                </div>
                <div className="text-2xs text-[var(--text-2)]">
                  Click fields → Inline edit
                </div>
              </CardHeader>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>Received</TableHead>
                    <TableHead className="text-right">Actual</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {upcoming.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <Input
                          type="date"
                          value={p.payDate}
                          onChange={(e) => updateRow(p, { payDate: e.target.value })}
                          className="h-8 w-[12rem]"
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end">
                          <MoneyInput
                            valueCents={p.amountCents}
                            onChangeCents={(c) => updateRow(p, { amountCents: c })}
                            className="h-8 w-32 text-right"
                          />
                        </div>
                      </TableCell>
                      <TableCell>
                        <Input
                          value={p.note ?? ""}
                          onChange={(e) => updateRow(p, { note: e.target.value })}
                          className="h-8"
                          placeholder="—"
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={p.actualReceived}
                            onCheckedChange={(v) => updateRow(p, { actualReceived: v })}
                          />
                          {p.actualReceived && p.settledByDraftId ? (
                            <StatusPill variant="default">Auto</StatusPill>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {p.actualReceived ? (
                          <div className="flex justify-end">
                            <MoneyInput
                              valueCents={p.actualAmountCents ?? p.amountCents}
                              onChangeCents={(c) => updateRow(p, { actualAmountCents: c })}
                              className="h-8 w-32 text-right"
                            />
                          </div>
                        ) : (
                          <span className="text-[var(--text-3)]">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => remove(p.id)}
                          aria-label="Delete"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          ) : null}

          {reconciled.length > 0 ? (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle className="mt-0.5">RECEIVED — RECONCILIATION</CardTitle>
                </div>
              </CardHeader>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Expected</TableHead>
                    <TableHead className="text-right">Actual</TableHead>
                    <TableHead className="text-right">Delta</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reconciled.slice(-12).reverse().map((p) => {
                    const delta = (p.actualAmountCents ?? p.amountCents) - p.amountCents;
                    return (
                      <TableRow key={p.id}>
                        <TableCell className="font-semibold text-[var(--text-0)]">
                          <DateLabel iso={p.actualDate ?? p.payDate} format="short" />
                          {p.actualDate && p.actualDate !== p.payDate ? (
                            <div className="text-2xs font-normal text-[var(--text-2)]">
                              sched <DateLabel iso={p.payDate} format="short" />
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right">
                          <Money cents={p.amountCents} />
                        </TableCell>
                        <TableCell className="text-right">
                          {p.actualReceived ? (
                            <Money cents={p.actualAmountCents ?? p.amountCents} />
                          ) : (
                            <span className="text-[var(--text-3)]">—</span>
                          )}
                        </TableCell>
                        <TableCell
                          className={`text-right ${delta < 0 ? "text-[var(--red)]" : delta > 0 ? "text-[var(--mint)]" : ""}`}
                        >
                          {p.actualReceived && delta !== 0 ? <Money cents={delta} signed /> : "—"}
                        </TableCell>
                        <TableCell className="text-[var(--text-2)]">{p.note ?? ""}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={p.actualReceived}
                              onCheckedChange={(v) => updateRow(p, { actualReceived: v })}
                            />
                            {p.actualReceived ? (
                              <span className="inline-flex items-center gap-1.5">
                                <StatusPill variant={delta === 0 ? "default" : "warn"}>Received</StatusPill>
                                {p.settledByDraftId ? (
                                  <StatusPill variant="default">Auto</StatusPill>
                                ) : null}
                              </span>
                            ) : (
                              <StatusPill variant="off">Pending</StatusPill>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
          ) : null}
        </>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add paycheck</DialogTitle>
          </DialogHeader>
          <CreatePaycheckForm
            onCancel={() => setCreateOpen(false)}
            onCreated={(p) => {
              setItems((prev) => [...prev, p].sort((a, b) => a.payDate.localeCompare(b.payDate)));
              setCreateOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={regenPreview !== null} onOpenChange={(o) => !o && setRegenPreview(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Regenerate paychecks</DialogTitle>
            <DialogDescription>
              {regenPreview && regenPreview.length > 0
                ? `Add ${regenPreview.length} new paycheck${regenPreview.length === 1 ? "" : "s"}:`
                : "No new paychecks to add."}
            </DialogDescription>
          </DialogHeader>
          {regenPreview && regenPreview.length > 0 ? (
            <AlertBar tag="Diff" variant="mint">
              Will append <strong className="text-[var(--mint)]">{regenPreview.length}</strong> future paycheck{regenPreview.length === 1 ? "" : "s"} matching defaults. Existing rows are left untouched.
            </AlertBar>
          ) : null}
          <ul className="max-h-72 space-y-1 overflow-auto text-[11px] tabular">
            {regenPreview?.map((p) => (
              <li
                key={p.payDate}
                className="flex justify-between border-b border-[var(--border-raw)] py-1.5 last:border-0"
              >
                <span className="text-[var(--text-1)]">
                  <DateLabel iso={p.payDate} format="short" />
                </span>
                <span className="text-[var(--mint)] font-semibold">
                  <Money cents={p.amountCents} />
                </span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRegenPreview(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={applyRegen}
              disabled={submitting || !regenPreview || regenPreview.length === 0}
            >
              {submitting ? "Applying…" : "Apply"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreatePaycheckForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (p: PaycheckRow) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [payDate, setPayDate] = React.useState(today);
  const [amountCents, setAmountCents] = React.useState(0);
  const [note, setNote] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setSubmitting(true);
        try {
          const res = await fetch("/api/paychecks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ payDate, amountCents, note: note.trim() || null }),
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error ?? "create failed");
          onCreated(json.paycheck as PaycheckRow);
          toast.success("Paycheck added");
        } catch (err) {
          toast.error((err as Error).message);
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="payDate">Date</Label>
        <Input
          id="payDate"
          type="date"
          required
          value={payDate}
          onChange={(e) => setPayDate(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label>AMOUNT ($)</Label>
        <MoneyInput valueCents={amountCents} onChangeCents={setAmountCents} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="note">Note</Label>
        <Input id="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Bonus, PTO…" />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
