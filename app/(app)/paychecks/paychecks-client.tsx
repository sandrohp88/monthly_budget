"use client";

import * as React from "react";
import { CalendarClock, Pencil, Plus, Trash2 } from "lucide-react";
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
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/money-input";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import { Switch } from "@/components/ui/switch";
import { StatusPill } from "@/components/ui/status-pill";
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
import { describeCadence, summarizeSequences } from "@/lib/paycheck-schedule";
import { ScheduleDialog, type ScheduleSeed } from "./schedule-dialog";
import type { PaycheckRow } from "@/lib/db/schema";

export function PaychecksClient({
  initialPaychecks,
  timezone,
  defaultMonths,
}: {
  initialPaychecks: PaycheckRow[];
  timezone: string;
  defaultMonths: number;
}) {
  const [items, setItems] = React.useState<PaycheckRow[]>(initialPaychecks);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [scheduleOpen, setScheduleOpen] = React.useState(false);
  const [scheduleSeed, setScheduleSeed] = React.useState<ScheduleSeed | null>(null);

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
    // The server releases the auto-reconcile draft link and the posted amount
    // when a row is un-marked received — mirror that locally so the AUTO pill
    // and the recorded figure drop immediately instead of waiting for a reload.
    // Clearing the amount matters: un-marking is how the user rejects a WRONG
    // auto-match, and without this the rejected figure was sent straight back
    // and persisted on the row it never belonged to.
    if (patch.actualReceived === false) {
      patch = { ...patch, settledByDraftId: null, actualDate: null, actualAmountCents: null };
    }
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
          // `??` can't carry an intentional null here (null is nullish, so it
          // would fall back to the row's old figure) — key presence decides.
          actualAmountCents:
            "actualAmountCents" in patch ? patch.actualAmountCents : row.actualAmountCents,
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

  // Every distinct run of paychecks on the page, grouped by label, with its
  // cadence and amount read back out of the rows — so "edit this schedule"
  // opens already describing what the user is looking at.
  const sequences = React.useMemo(() => summarizeSequences(items, today), [items, today]);

  const editSequence = (label: string) => {
    const seq = sequences.find((s) => s.label === label);
    if (!seq) return;
    setScheduleSeed({
      label,
      amountCents: seq.amountCents,
      // Anchor on the next unpaid payday: editing a run should re-space what is
      // still ahead, not drag it back to where the run originally started.
      anchorDate: seq.nextPayDate ?? today,
      cadence: seq.cadence,
      existing: true,
    });
    setScheduleOpen(true);
  };

  const newSequence = () => {
    setScheduleSeed({
      label: "",
      amountCents: 0,
      anchorDate: today,
      cadence: null,
      existing: false,
    });
    setScheduleOpen(true);
  };

  return (
    <div className="space-y-6 fade-in">
      <PageHead
        title="Paychecks"
        subtitle="Income schedule · scheduled and actual income reconciliation"
        actions={
          <>
            <Button variant="outline" onClick={newSequence}>
              <CalendarClock className="h-3 w-3" /> New schedule
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

      <Card>
        <CardHeader>
          <div>
            <CardTitle className="mt-0.5">Schedules</CardTitle>
            <p className="mt-1 text-2xs text-[var(--text-3)]">
              How your income repeats. Edit one to change the amount or re-space the paydays ahead.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={newSequence}>
            <Plus className="h-3 w-3" /> New schedule
          </Button>
        </CardHeader>
        {sequences.length === 0 ? (
          <div className="px-4 py-8 text-center text-[11px] text-[var(--text-2)]">
            No schedule yet — create one and the paydays are laid out for you.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Whose</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Repeats</TableHead>
                <TableHead>Next payday</TableHead>
                <TableHead>Planned through</TableHead>
                <TableHead className="text-right">Edit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sequences.map((seq) => (
                <TableRow key={seq.label || "__main__"}>
                  <TableCell className="text-[var(--text-0)]">
                    {seq.label || "Main"}
                    {seq.settledCount > 0 ? (
                      <span className="ml-2 text-2xs text-[var(--text-3)]">
                        {seq.settledCount} received
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right text-[var(--mint)] font-semibold">
                    <Money cents={seq.amountCents} />
                  </TableCell>
                  <TableCell className="text-[var(--text-1)]">
                    {describeCadence(seq.cadence)}
                  </TableCell>
                  <TableCell>
                    {seq.nextPayDate ? (
                      <DateLabel iso={seq.nextPayDate} format="short" />
                    ) : (
                      <span className="text-[var(--text-3)]">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-[var(--text-2)]">
                    {seq.lastPayDate ? (
                      <>
                        <DateLabel iso={seq.lastPayDate} format="short" />
                        <span className="ml-2 text-2xs text-[var(--text-3)]">
                          {seq.upcomingCount} ahead
                        </span>
                      </>
                    ) : (
                      <span className="text-[var(--text-3)]">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => editSequence(seq.label)}>
                      <Pencil className="h-3 w-3" /> Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No paychecks yet</CardTitle>
          </CardHeader>
          <div className="px-4 py-8 text-center">
            <p className="mb-4 text-[11px] tracking-wide text-[var(--text-2)]">
              Create a schedule to lay out your paydays, or add a single paycheck.
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

      <ScheduleDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        seed={scheduleSeed}
        defaultMonths={defaultMonths}
        onApplied={setItems}
      />
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
