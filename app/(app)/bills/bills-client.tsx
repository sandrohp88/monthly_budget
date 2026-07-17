"use client";

import * as React from "react";
import { Calculator, Plus, Download, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHead } from "@/components/ui/page-head";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetBody, SheetFooter } from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Money } from "@/components/money";
import { MoneyInput } from "@/components/money-input";
import { DateLabel } from "@/components/date-label";
import { StatusPill } from "@/components/ui/status-pill";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BillForm, type BillFormValues } from "./bill-form";
import { cn } from "@/lib/cn";
import { nextBillOccurrence } from "@/lib/bills";
import { todayIso } from "@/lib/dates";
import type { BillRow } from "@/lib/db/schema";

type VariableBill = {
  id: string;
  userId: string;
  name: string;
  category: string;
  amountCents: number;
  intervalMonths: number;
  anchorDate: string;
  notes: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  cardIds: string[];
};

type VariableBillFormValues = {
  name: string;
  category: string;
  amountCents: number;
  intervalMonths: number;
  anchorDate: string;
  cardIds: string[];
  notes: string | null;
};

function monthlyEquivalent(b: Pick<BillRow, "amountCents" | "intervalMonths">): number {
  return b.intervalMonths > 0 ? Math.round(b.amountCents / b.intervalMonths) : b.amountCents;
}

function intervalLabel(months: number): string {
  switch (months) {
    case 1: return "MONTHLY";
    case 2: return "EVERY 2 MO";
    case 3: return "QUARTERLY";
    case 6: return "EVERY 6 MO";
    case 12: return "ANNUAL";
    default: return `Every ${months} mo`;
  }
}

export type BillCardOption = { id: string; name: string; isActive: boolean };

/** Latest bill occurrence settled by a posted linked-account transaction. */
export type LastPaid = {
  occurrenceDate: string;
  paidDate: string;
  paidAmountCents: number;
};

type OverrideItem = {
  id: string;
  billId: string;
  dueDate: string;
  amountCents: number;
  notes: string | null;
};

export function BillsClient({
  initialBills,
  initialVariableBills,
  categories,
  cards,
  initialOverrides = [],
  lastPaidByBill = {},
  timezone,
}: {
  initialBills: BillRow[];
  initialVariableBills: VariableBill[];
  categories: ReadonlyArray<string>;
  cards: ReadonlyArray<BillCardOption>;
  initialOverrides?: OverrideItem[];
  lastPaidByBill?: Record<string, LastPaid>;
  timezone: string;
}) {
  const [bills, setBills] = React.useState<BillRow[]>(initialBills);
  const [variableBills, setVariableBills] = React.useState<VariableBill[]>(initialVariableBills);
  const [overrides, setOverrides] = React.useState<OverrideItem[]>(initialOverrides);
  const [categoriesState, setCategoriesState] = React.useState<string[]>(() => [...categories]);
  const [showArchived, setShowArchived] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState<string>("ALL");
  const [sortKey, setSortKey] = React.useState<"name" | "amount" | "next" | "monthly">("name");
  const today = todayIso(timezone);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createVariableOpen, setCreateVariableOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<BillRow | null>(null);
  const [editingVariable, setEditingVariable] = React.useState<VariableBill | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const visible = bills
    .filter((b) => (showArchived ? true : b.isActive))
    .filter((b) => categoryFilter === "ALL" || b.category.toUpperCase() === categoryFilter)
    .filter(
      (b) =>
        b.name.toLowerCase().includes(filter.toLowerCase()) ||
        b.category.toLowerCase().includes(filter.toLowerCase()),
    )
    .sort((a, b) => {
      switch (sortKey) {
        case "amount": return a.amountCents - b.amountCents;
        case "next": return nextBillOccurrence(a, today).localeCompare(nextBillOccurrence(b, today));
        case "monthly": return monthlyEquivalent(a) - monthlyEquivalent(b);
        default: return a.name.localeCompare(b.name);
      }
    });

  const totalAmount = visible.reduce((s, b) => s + b.amountCents, 0);
  const totalMonthly = visible.reduce((s, b) => s + monthlyEquivalent(b), 0);
  const activeCount = bills.filter((b) => b.isActive).length;
  const archivedCount = bills.length - activeCount;
  const activeVariableBills = variableBills.filter((b) => b.isActive);
  const variableMonthly = activeVariableBills.reduce(
    (sum, b) => sum + monthlyEquivalent(b),
    0,
  );

  const allCategories = Array.from(new Set(bills.map((b) => b.category.toUpperCase()))).sort();

  // Reconciled payments only exist in linked-balance mode — hide the column
  // entirely for manual-mode users instead of showing a dash for every row.
  const hasPaidData = Object.keys(lastPaidByBill).length > 0;

  // Lookup card name by id for the in-row "VIA …" pill
  const cardById = React.useMemo(
    () => new Map(cards.map((c) => [c.id, c])),
    [cards],
  );

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

  const create = async (values: BillFormValues) => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/bills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "create failed");
      setBills((prev) => [...prev, json.bill as BillRow]);
      setCreateOpen(false);
      toast.success("Bill added");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const createVariable = async (values: VariableBillFormValues) => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/variable-bills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "create failed");
      setVariableBills((prev) => [...prev, json.variableBill as VariableBill]);
      setCreateVariableOpen(false);
      toast.success("Variable bill added");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const update = async (values: BillFormValues) => {
    if (!editing) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/bills/${editing.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...values, isActive: editing.isActive }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "update failed");
      setBills((prev) => prev.map((b) => (b.id === editing.id ? (json.bill as BillRow) : b)));
      setEditing(null);
      toast.success("Bill updated");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const updateVariable = async (values: VariableBillFormValues) => {
    if (!editingVariable) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/variable-bills/${editingVariable.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...values, isActive: editingVariable.isActive }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "update failed");
      setVariableBills((prev) =>
        prev.map((b) => (b.id === editingVariable.id ? (json.variableBill as VariableBill) : b)),
      );
      setEditingVariable(null);
      toast.success("Variable bill updated");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const archive = async (id: string) => {
    const prev = bills;
    setBills((curr) => curr.map((b) => (b.id === id ? { ...b, isActive: false } : b)));
    setEditing(null);
    try {
      const res = await fetch(`/api/bills/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("archive failed");
      toast.success("Bill archived");
    } catch (e) {
      setBills(prev);
      toast.error((e as Error).message);
    }
  };

  const archiveVariable = async (id: string) => {
    const prev = variableBills;
    setVariableBills((curr) => curr.map((b) => (b.id === id ? { ...b, isActive: false } : b)));
    setEditingVariable(null);
    try {
      const res = await fetch(`/api/variable-bills/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("archive failed");
      toast.success("Variable bill archived");
    } catch (e) {
      setVariableBills(prev);
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-6 fade-in">
      <PageHead
        title="Bills"
        subtitle="Recurring expenses · any cycle from monthly to multi-year"
        actions={
          <>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <Switch checked={showArchived} onCheckedChange={setShowArchived} />
              <span className="text-2xs text-[var(--text-2)]">
                Show archived
              </span>
            </label>
            <Button variant="outline">
              <Download className="h-3 w-3" /> Export
            </Button>
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3 w-3" /> Add bill
            </Button>
            <Button variant="outline" onClick={() => setCreateVariableOpen(true)}>
              <Calculator className="h-3 w-3" /> Add variable
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Tab
          active={categoryFilter === "ALL"}
          onClick={() => setCategoryFilter("ALL")}
        >
          All · {activeCount}
        </Tab>
        {allCategories.map((c) => (
          <Tab key={c} active={categoryFilter === c} onClick={() => setCategoryFilter(c)}>
            {c}
          </Tab>
        ))}
        <div className="ml-auto w-56">
          <Input
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="text-[11px]"
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No bills yet</CardTitle>
          </CardHeader>
          <div className="px-4 py-8 text-center">
            <p className="mb-4 text-[11px] tracking-wide text-[var(--text-2)]">
              Add your first recurring bill to start projecting.
            </p>
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3 w-3" /> Add your first bill
            </Button>
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="mt-0.5">
                {activeCount} active · {archivedCount} archived
              </CardTitle>
            </div>
            <div className="text-2xs text-[var(--text-2)]">
              Click a row to edit
            </div>
          </CardHeader>
          <Table stackOnMobile>
            <TableHeader>
              <TableRow>
                <TableHead onClick={() => setSortKey("name")} className="cursor-pointer">
                  Name ↕
                </TableHead>
                <TableHead>Category</TableHead>
                <TableHead onClick={() => setSortKey("amount")} className="cursor-pointer text-right">
                  Amount ↕
                </TableHead>
                <TableHead>Every</TableHead>
                <TableHead onClick={() => setSortKey("next")} className="cursor-pointer text-right">
                  Next due ↕
                </TableHead>
                {hasPaidData ? <TableHead className="text-right">Last paid</TableHead> : null}
                <TableHead>Autopay</TableHead>
                <TableHead onClick={() => setSortKey("monthly")} className="cursor-pointer text-right">
                  Monthly eq ↕
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((b) => (
                <TableRow
                  key={b.id}
                  className={cn("cursor-pointer", !b.isActive && "opacity-60")}
                  onClick={() => setEditing(b)}
                >
                  <TableCell label="Bill" className="font-semibold text-[var(--text-0)]">
                    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center justify-end gap-x-2 gap-y-1">
                      {b.name}
                      {!b.isActive ? <Badge variant="muted">Archived</Badge> : null}
                      {b.paidViaCardId ? (
                        <Badge
                          variant={cardById.get(b.paidViaCardId)?.isActive ? "secondary" : "muted"}
                          className="max-w-[9.5rem] overflow-hidden"
                          title={`${cardById.get(b.paidViaCardId)?.name ?? "Unknown"} — ${
                            cardById.get(b.paidViaCardId)?.isActive
                              ? "paid via this card, skipped from cash projection"
                              : "linked card is archived, falling back to cash"
                          }`}
                        >
                          <span className="truncate">
                            via {cardById.get(b.paidViaCardId)?.name ?? "Unknown"}
                          </span>
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell label="Category" className="text-[var(--text-2)]">{b.category}</TableCell>
                  <TableCell label="Amount" className="text-right">
                    <Money cents={b.amountCents} />
                  </TableCell>
                  <TableCell label="Every">
                    <StatusPill variant={b.intervalMonths === 1 ? "default" : "warn"}>
                      {intervalLabel(b.intervalMonths)}
                    </StatusPill>
                  </TableCell>
                  <TableCell label="Next due" className="text-right tabular">
                    <DateLabel iso={nextBillOccurrence(b, today)} format="short" />
                  </TableCell>
                  {hasPaidData ? (
                    <TableCell label="Last paid" className="text-right tabular">
                      {lastPaidByBill[b.id] ? (
                        <span
                          className="text-[var(--mint)]"
                          title="Matched from posted linked-account transactions (current cycle)"
                        >
                          <DateLabel iso={lastPaidByBill[b.id]!.paidDate} format="short" /> ·{" "}
                          <Money cents={lastPaidByBill[b.id]!.paidAmountCents} />
                        </span>
                      ) : (
                        <span className="text-[var(--text-3)]">—</span>
                      )}
                    </TableCell>
                  ) : null}
                  <TableCell label="Autopay">
                    <StatusPill variant={b.autoPay ? "default" : "off"}>
                      {b.autoPay ? "On" : "Off"}
                    </StatusPill>
                  </TableCell>
                  <TableCell label="Monthly eq" className="text-right text-[var(--mint)] font-semibold">
                    <Money cents={monthlyEquivalent(b)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={2} className="text-[var(--text-0)]">
                  Total · {visible.length} items
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={totalAmount} />
                </TableCell>
                <TableCell colSpan={hasPaidData ? 4 : 3} />
                <TableCell className="text-right text-[var(--mint)]">
                  <Money cents={totalMonthly} />
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div>
            <CardTitle className="mt-0.5">
              {activeVariableBills.length} variable · <Money cents={variableMonthly} /> / mo
            </CardTitle>
          </div>
          <Button size="sm" variant="outline" onClick={() => setCreateVariableOpen(true)}>
            <Plus className="h-3 w-3" /> Add variable
          </Button>
        </CardHeader>
        {variableBills.length === 0 ? (
          <div className="px-4 py-8 text-center text-[11px] text-[var(--text-3)]">
            No variable card forecasts
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Expected</TableHead>
                <TableHead>Every</TableHead>
                <TableHead>Cards</TableHead>
                <TableHead className="text-right">Next</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {variableBills
                .filter((b) => (showArchived ? true : b.isActive))
                .map((b) => {
                  const names = b.cardIds
                    .map((id) => cardById.get(id)?.name)
                    .filter(Boolean)
                    .join(", ");
                  return (
                    <TableRow
                      key={b.id}
                      className={cn("cursor-pointer", !b.isActive && "opacity-60")}
                      onClick={() => setEditingVariable(b)}
                    >
                      <TableCell className="font-semibold text-[var(--text-0)]">
                        {b.name}
                        {!b.isActive ? (
                          <Badge variant="muted" className="ml-2">
                            Archived
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-[var(--text-2)]">{b.category}</TableCell>
                      <TableCell className="text-right">
                        <Money cents={b.amountCents} />
                      </TableCell>
                      <TableCell>
                        <StatusPill variant={b.intervalMonths === 1 ? "default" : "warn"}>
                          {intervalLabel(b.intervalMonths)}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="max-w-[220px] truncate text-2xs text-[var(--text-2)]">
                        {names || "No active cards"}
                      </TableCell>
                      <TableCell className="text-right tabular">
                        <DateLabel iso={nextBillOccurrence(b, today)} format="short" />
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add bill</DialogTitle>
          </DialogHeader>
          <BillForm
            categories={categoriesState}
            cards={cards}
            timezone={timezone}
            onCategoryAdded={(c) => setCategoriesState((prev) => [...prev, c])}
            onSubmit={create}
            onCancel={() => setCreateOpen(false)}
            submitting={submitting}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={createVariableOpen} onOpenChange={setCreateVariableOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add variable bill</DialogTitle>
          </DialogHeader>
          <VariableBillForm
            categories={categoriesState}
            cards={cards}
            timezone={timezone}
            onSubmit={createVariable}
            onCancel={() => setCreateVariableOpen(false)}
            submitting={submitting}
          />
        </DialogContent>
      </Dialog>

      <Sheet open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <SheetContent>
          {editing ? (
            <>
              <SheetHeader>
                <SheetTitle>{editing.name}</SheetTitle>
              </SheetHeader>
              <SheetBody>
                <BillForm
                  initial={editing}
                  categories={categoriesState}
                  cards={cards}
                  timezone={timezone}
                  onCategoryAdded={(c) => setCategoriesState((prev) => [...prev, c])}
                  onSubmit={update}
                  onCancel={() => setEditing(null)}
                  submitting={submitting}
                  hideActions
                />
                <OverrideSection
                  billId={editing.id}
                  overrides={overrides.filter((o) => o.billId === editing.id)}
                  timezone={timezone}
                  onOverridesChange={(updated) =>
                    setOverrides((prev) => [
                      ...prev.filter((o) => o.billId !== editing.id),
                      ...updated,
                    ])
                  }
                />
              </SheetBody>
              <SheetFooter>
                {editing.isActive ? (
                  <Button variant="destructive" onClick={() => archive(editing.id)}>
                    Soft delete
                  </Button>
                ) : (
                  <span />
                )}
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    form="bill-form"
                    type="submit"
                    disabled={submitting}
                  >
                    {submitting ? "Saving…" : "Save"}
                  </Button>
                </div>
              </SheetFooter>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <Sheet open={editingVariable !== null} onOpenChange={(o) => !o && setEditingVariable(null)}>
        <SheetContent>
          {editingVariable ? (
            <>
              <SheetHeader>
                <SheetTitle>{editingVariable.name}</SheetTitle>
              </SheetHeader>
              <SheetBody>
                <VariableBillForm
                  initial={editingVariable}
                  categories={categoriesState}
                  cards={cards}
                  timezone={timezone}
                  onSubmit={updateVariable}
                  onCancel={() => setEditingVariable(null)}
                  submitting={submitting}
                  hideActions
                />
              </SheetBody>
              <SheetFooter>
                {editingVariable.isActive ? (
                  <Button variant="destructive" onClick={() => archiveVariable(editingVariable.id)}>
                    Soft delete
                  </Button>
                ) : (
                  <span />
                )}
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setEditingVariable(null)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    form="variable-bill-form"
                    type="submit"
                    disabled={submitting}
                  >
                    {submitting ? "Saving…" : "Save"}
                  </Button>
                </div>
              </SheetFooter>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function OverrideSection({
  billId,
  overrides,
  timezone,
  onOverridesChange,
}: {
  billId: string;
  overrides: OverrideItem[];
  timezone: string;
  onOverridesChange: (updated: OverrideItem[]) => void;
}) {
  const [addOpen, setAddOpen] = React.useState(false);
  const [newDate, setNewDate] = React.useState(todayIso(timezone));
  const [newAmount, setNewAmount] = React.useState(0);
  const [newNotes, setNewNotes] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const addOverride = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/bills/${billId}/payment-overrides`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dueDate: newDate,
          amountCents: newAmount,
          notes: newNotes.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "save failed");
      const created = json.override as OverrideItem;
      onOverridesChange([
        ...overrides.filter((o) => o.dueDate !== created.dueDate),
        created,
      ]);
      setAddOpen(false);
      setNewDate(todayIso(timezone));
      setNewAmount(0);
      setNewNotes("");
      toast.success("Override saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const removeOverride = async (dueDate: string) => {
    try {
      const res = await fetch(
        `/api/bills/${billId}/payment-overrides?dueDate=${dueDate}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("delete failed");
      onOverridesChange(overrides.filter((o) => o.dueDate !== dueDate));
      toast.success("Override removed");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const sorted = [...overrides].sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return (
    <div className="mt-6 border-t border-[var(--border-raw)] pt-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-2xs text-[var(--text-3)]">
            {"// OVERRIDES"}
          </div>
          <div className="text-[11px] font-semibold text-[var(--text-0)]">
            Payment adjustments
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setAddOpen(!addOpen)}
        >
          <Plus className="h-3 w-3" /> Add
        </Button>
      </div>

      {addOpen && (
        <div className="mb-4 space-y-3 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] p-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="override-date">Due date</Label>
              <Input
                id="override-date"
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Amount</Label>
              <MoneyInput valueCents={newAmount} onChangeCents={setNewAmount} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="override-notes">Notes</Label>
            <Input
              id="override-notes"
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              placeholder="Optional note"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setAddOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="primary"
              onClick={addOverride}
              disabled={saving || !newDate}
            >
              {saving ? "Saving…" : "Save override"}
            </Button>
          </div>
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="py-3 text-center text-2xs text-[var(--text-3)]">
          No overrides — Using default amounts
        </div>
      ) : (
        <div className="divide-y divide-[var(--border-raw)] rounded-sm border border-[var(--border-raw)]">
          {sorted.map((o) => (
            <div
              key={o.dueDate}
              className="flex items-center justify-between px-3 py-2"
            >
              <div className="min-w-0">
                <div className="text-[11px] tabular text-[var(--text-0)]">
                  <DateLabel iso={o.dueDate} format="short" />
                  <span className="ml-2 font-bold text-[var(--cyan)]">
                    <Money cents={o.amountCents} />
                  </span>
                </div>
                {o.notes ? (
                  <div className="mt-0.5 truncate text-2xs text-[var(--text-3)]">
                    {o.notes}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => removeOverride(o.dueDate)}
                className="ml-2 text-[var(--text-3)] hover:text-[var(--red)] transition-colors cursor-pointer"
                title="Remove override"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-sm border px-3 py-1.5 text-2xs font-medium transition-colors cursor-pointer",
        active
          ? "bg-[var(--mint-glow)] text-[var(--mint)] border-[var(--mint-dim)]"
          : "bg-[var(--bg-2)] text-[var(--text-2)] border-[var(--border-raw)] hover:text-[var(--text-0)] hover:border-[var(--border-2)]",
      )}
    >
      {children}
    </button>
  );
}

function VariableBillForm({
  initial,
  categories,
  cards,
  timezone,
  onSubmit,
  onCancel,
  submitting,
  hideActions,
}: {
  initial?: VariableBill;
  categories: ReadonlyArray<string>;
  cards: ReadonlyArray<BillCardOption>;
  timezone: string;
  onSubmit: (values: VariableBillFormValues) => void | Promise<void>;
  onCancel: () => void;
  submitting?: boolean;
  hideActions?: boolean;
}) {
  const activeCards = cards.filter((card) => card.isActive);
  const today = todayIso(timezone);
  const [name, setName] = React.useState(initial?.name ?? "");
  const [category, setCategory] = React.useState(initial?.category ?? categories[0] ?? "Other");
  const [amountCents, setAmountCents] = React.useState(initial?.amountCents ?? 0);
  const [intervalMonths, setIntervalMonths] = React.useState(initial?.intervalMonths ?? 1);
  const [anchorDate, setAnchorDate] = React.useState(
    initial ? nextBillOccurrence(initial, today) : today,
  );
  const [cardIds, setCardIds] = React.useState<string[]>(
    initial?.cardIds.length ? initial.cardIds : activeCards.slice(0, 1).map((card) => card.id),
  );
  const [notes, setNotes] = React.useState(initial?.notes ?? "");
  const [avgLoading, setAvgLoading] = React.useState(false);
  const [average, setAverage] = React.useState<{
    averageCents: number;
    sampleCount: number;
    monthlyTotals: Array<{ month: string; amountCents: number }>;
  } | null>(null);

  const toggleCard = (cardId: string) => {
    setCardIds((current) =>
      current.includes(cardId)
        ? current.filter((id) => id !== cardId)
        : [...current, cardId],
    );
  };

  const loadAverage = async () => {
    setAvgLoading(true);
    try {
      const res = await fetch("/api/variable-bills/average", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          category,
          cardIds,
          lookbackMonths: 6,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "average failed");
      setAverage(json.average);
      setAmountCents(json.average.averageCents ?? 0);
      toast.success("Average loaded");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAvgLoading(false);
    }
  };

  const monthlyEq = intervalMonths > 0 ? Math.round(amountCents / intervalMonths) : amountCents;

  return (
    <form
      id="variable-bill-form"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          name: name.trim(),
          category,
          amountCents,
          intervalMonths,
          anchorDate,
          cardIds,
          notes: notes.trim() ? notes.trim() : null,
        });
      }}
    >
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="variable-name">Name</Label>
          <Input
            id="variable-name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Groceries"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Expected amount</Label>
          <MoneyInput valueCents={amountCents} onChangeCents={setAmountCents} />
        </div>
        <div className="space-y-1.5">
          <Label>Category</Label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="variable-anchor">Next expected date</Label>
          <Input
            id="variable-anchor"
            type="date"
            required
            value={anchorDate}
            onChange={(e) => setAnchorDate(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="variable-interval">Every N months</Label>
          <Input
            id="variable-interval"
            type="number"
            min={1}
            max={120}
            required
            value={intervalMonths}
            onChange={(e) => setIntervalMonths(Math.max(1, Number(e.target.value) || 1))}
          />
        </div>
        <div className="col-span-2 space-y-2">
          <Label>Credit cards</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {activeCards.map((card) => (
              <label
                key={card.id}
                className={cn(
                  "flex cursor-pointer items-center justify-between rounded-sm border px-3 py-2 text-2xs",
                  cardIds.includes(card.id)
                    ? "border-[var(--mint-dim)] bg-[var(--mint-glow)] text-[var(--mint)]"
                    : "border-[var(--border-raw)] bg-[var(--bg-2)] text-[var(--text-2)]",
                )}
              >
                <span>{card.name}</span>
                <input
                  type="checkbox"
                  checked={cardIds.includes(card.id)}
                  onChange={() => toggleCard(card.id)}
                  className="h-3 w-3 accent-[var(--mint)]"
                />
              </label>
            ))}
          </div>
          {activeCards.length === 0 ? (
            <p className="text-2xs text-[var(--amber)]">
              Add an active credit card first.
            </p>
          ) : null}
        </div>
        <div className="col-span-2 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-2xs text-[var(--text-2)]">
                History avg
              </div>
              <div className="text-2xs text-[var(--text-3)]">
                Last 6 months · approved linked transactions
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={loadAverage}
              disabled={avgLoading || cardIds.length === 0}
            >
              <Calculator className="h-3 w-3" /> {avgLoading ? "Loading…" : "Use avg"}
            </Button>
          </div>
          {average ? (
            <div className="mt-2 flex items-center justify-between text-2xs text-[var(--text-2)]">
              <span>{average.sampleCount} matching transactions</span>
              <span className="text-[13px] font-bold text-[var(--mint)] tabular">
                <Money cents={average.averageCents} />
              </span>
            </div>
          ) : null}
        </div>
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="variable-notes">Notes</Label>
          <Input id="variable-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="col-span-2 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 py-2.5">
          <div className="flex items-center justify-between text-2xs text-[var(--text-2)]">
            <span>Monthly equivalent</span>
            <span className="text-[13px] font-bold text-[var(--mint)] tabular">
              <Money cents={monthlyEq} />
            </span>
          </div>
        </div>
      </div>
      {hideActions ? null : (
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={submitting || !name.trim() || cardIds.length === 0}
          >
            {submitting ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
    </form>
  );
}
