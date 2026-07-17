"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHead } from "@/components/ui/page-head";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/money-input";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tile, TileGrid } from "@/components/ui/tile";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CategoryDialog } from "@/components/category-dialog";
import { Plus as PlusIcon } from "lucide-react";
import { addDaysIso, todayIso } from "@/lib/dates";
import { cn } from "@/lib/cn";
import type { CreditCardRow, OneTimeExpenseRow } from "@/lib/db/schema";

type FilterKey = "30" | "60" | "90" | "all";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatMonthKey(key: string): string {
  const [y, m] = key.split("-");
  return `${MONTH_NAMES[Number(m) - 1]} · ${y}`;
}

export function ExtrasClient({
  initialExtras,
  categories,
  creditCards,
  timezone,
}: {
  initialExtras: OneTimeExpenseRow[];
  categories: ReadonlyArray<string>;
  creditCards: CreditCardRow[];
  timezone: string;
}) {
  const [items, setItems] = React.useState<OneTimeExpenseRow[]>(initialExtras);
  const [categoriesState, setCategoriesState] = React.useState<string[]>(() => [...categories]);
  const [filter, setFilter] = React.useState<FilterKey>("90");
  const [createOpen, setCreateOpen] = React.useState(false);
  const today = todayIso(timezone);

  const visible = React.useMemo(() => {
    if (filter === "all") return items;
    const days = Number(filter);
    const horizon = addDaysIso(today, days);
    return items.filter((e) => e.date >= today && e.date <= horizon);
  }, [items, filter, today]);

  const grouped = React.useMemo(() => {
    const groups = new Map<string, OneTimeExpenseRow[]>();
    for (const e of visible) {
      const key = e.date.slice(0, 7);
      const arr = groups.get(key) ?? [];
      arr.push(e);
      groups.set(key, arr);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, rows]) => ({
        month,
        rows: rows.sort((a, b) => a.date.localeCompare(b.date)),
        total: rows.reduce((s, r) => s + r.amountCents, 0),
      }));
  }, [visible]);

  const totalCents = visible.reduce((s, e) => s + e.amountCents, 0);
  const largest = visible.reduce<OneTimeExpenseRow | null>(
    (best, e) => (!best || e.amountCents > best.amountCents ? e : best),
    null,
  );
  const categoryCount = new Set(visible.map((e) => e.category)).size;
  const cardNameById = React.useMemo(
    () => new Map(creditCards.map((card) => [card.id, card.name] as const)),
    [creditCards],
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

  const remove = async (id: string) => {
    const prev = items;
    setItems((curr) => curr.filter((e) => e.id !== id));
    try {
      const res = await fetch(`/api/extras/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      toast.success("Expense removed");
    } catch (err) {
      setItems(prev);
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="space-y-6 fade-in">
      <PageHead
        title="One-time"
        subtitle="Planned non-recurring expenses · grouped by month"
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3 w-3" /> Add expense
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Tab active={filter === "30"} onClick={() => setFilter("30")}>
          NEXT 30D
        </Tab>
        <Tab active={filter === "60"} onClick={() => setFilter("60")}>
          NEXT 60D
        </Tab>
        <Tab active={filter === "90"} onClick={() => setFilter("90")}>
          NEXT 90D
        </Tab>
        <Tab active={filter === "all"} onClick={() => setFilter("all")}>
          All · {items.length}
        </Tab>
      </div>

      <TileGrid cols={3}>
        <Tile
          label={`${filter === "all" ? "" : `${filter}-DAY `}TOTAL`}
          value={<Money cents={totalCents} />}
          delta={`${visible.length} expense${visible.length === 1 ? "" : "s"}`}
        />
        <Tile
          label="Largest"
          value={largest ? <Money cents={largest.amountCents} /> : <span className="text-[var(--text-2)] text-base">—</span>}
          delta={largest ? `${largest.description} · ${largest.date.slice(5, 7)}/${largest.date.slice(8)}` : "no expenses"}
        />
        <Tile label="Categories" value={categoryCount} delta="distinct" />
      </TileGrid>

      {grouped.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No upcoming expenses</CardTitle>
          </CardHeader>
          <div className="px-4 py-8 text-center">
            <p className="mb-4 text-[11px] tracking-wide text-[var(--text-2)]">
              Add a one-time expense to plan around it.
            </p>
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3 w-3" /> Add expense
            </Button>
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="mt-0.5">PLANNED — Grouped by month</CardTitle>
            </div>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Paid with</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {grouped.map((g) => (
                <React.Fragment key={g.month}>
                  <tr className="border-y border-[var(--border-2)] bg-[var(--bg-1)]">
                    <td colSpan={7} className="px-4 py-2.5 text-2xs font-bold text-[var(--mint)]">
                      {`// ${formatMonthKey(g.month)} — ${g.rows.length} EXPENSE${g.rows.length === 1 ? "" : "s"} — `}
                      <Money cents={g.total} />
                    </td>
                  </tr>
                  {g.rows.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>
                        <DateLabel iso={e.date} format="short" />
                      </TableCell>
                      <TableCell className="font-semibold text-[var(--text-0)]">
                        {e.description}
                      </TableCell>
                      <TableCell className="text-[var(--text-2)]">{e.category}</TableCell>
                      <TableCell className="text-[var(--text-2)]">
                        {e.paidViaCardId ? (cardNameById.get(e.paidViaCardId) ?? "Archived card") : "Cash"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Money cents={e.amountCents} />
                      </TableCell>
                      <TableCell className="text-[var(--text-2)]">{e.notes ?? ""}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Remove"
                          onClick={() => remove(e.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </React.Fragment>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={4} className="text-[var(--text-0)]">
                  Total · {visible.length} expense{visible.length === 1 ? "" : "s"}
                </TableCell>
                <TableCell className="text-right text-[var(--mint)]">
                  <Money cents={totalCents} />
                </TableCell>
                <TableCell colSpan={2} />
              </TableRow>
            </TableFooter>
          </Table>
        </Card>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add expense</DialogTitle>
          </DialogHeader>
          <CreateExtraForm
            categories={categoriesState}
            creditCards={creditCards}
            onCategoryAdded={(c) => setCategoriesState((prev) => [...prev, c])}
            onCancel={() => setCreateOpen(false)}
            onCreated={(e) => {
              setItems((prev) => [...prev, e].sort((a, b) => a.date.localeCompare(b.date)));
              setCreateOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>
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

function CreateExtraForm({
  categories,
  creditCards,
  onCancel,
  onCreated,
  onCategoryAdded,
}: {
  categories: ReadonlyArray<string>;
  creditCards: CreditCardRow[];
  onCancel: () => void;
  onCreated: (e: OneTimeExpenseRow) => void;
  onCategoryAdded?: (name: string) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = React.useState(today);
  const [description, setDescription] = React.useState("");
  const [amountCents, setAmountCents] = React.useState(0);
  const [category, setCategory] = React.useState(categories[0] ?? "Other");
  const [paidViaCardId, setPaidViaCardId] = React.useState<string>("cash");
  const [notes, setNotes] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [categoryDialogOpen, setCategoryDialogOpen] = React.useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setSubmitting(true);
        try {
          const res = await fetch("/api/extras", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              date,
              description: description.trim(),
              amountCents,
              category,
              paidViaCardId: paidViaCardId === "cash" ? null : paidViaCardId,
              notes: notes.trim() || null,
            }),
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error ?? "create failed");
          onCreated(json.extra as OneTimeExpenseRow);
          toast.success("Expense added");
        } catch (err) {
          toast.error((err as Error).message);
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="date">Date</Label>
          <Input id="date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="amount">AMOUNT ($)</Label>
          <MoneyInput id="amount" valueCents={amountCents} onChangeCents={setAmountCents} />
        </div>
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="description">Description</Label>
          <Input
            id="description"
            required
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="col-span-2 space-y-1.5">
          <Label className="flex items-center justify-between">
            <span>Category</span>
            <button
              type="button"
              onClick={() => setCategoryDialogOpen(true)}
              className="inline-flex items-center gap-1 normal-case tracking-normal text-2xs text-[var(--mint)] hover:text-[var(--mint-bright)] cursor-pointer"
            >
              <PlusIcon className="h-3 w-3" /> Add new
            </button>
          </Label>
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
        <div className="col-span-2 space-y-1.5">
          <Label>Paid with</Label>
          <Select value={paidViaCardId} onValueChange={setPaidViaCardId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cash">Cash / bank</SelectItem>
              {creditCards.map((card) => (
                <SelectItem key={card.id} value={card.id}>
                  {card.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="notes">Notes</Label>
          <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={submitting || !description.trim()}>
          {submitting ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>

      <CategoryDialog
        open={categoryDialogOpen}
        onClose={() => setCategoryDialogOpen(false)}
        defaultKind="expense"
        onCreated={(c) => {
          setCategoryDialogOpen(false);
          setCategory(c.name);
          onCategoryAdded?.(c.name);
        }}
      />
    </form>
  );
}
