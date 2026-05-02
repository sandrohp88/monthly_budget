"use client";

import * as React from "react";
import { Plus, Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { CardSubTag, PageHead } from "@/components/ui/page-head";
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
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import { StatusPill } from "@/components/ui/status-pill";
import { Badge } from "@/components/ui/badge";
import { BillForm, type BillFormValues } from "./bill-form";
import { cn } from "@/lib/cn";
import { todayIso } from "@/lib/dates";
import type { BillRow } from "@/lib/db/schema";

function monthlyEquivalent(b: BillRow): number {
  return b.intervalMonths > 0 ? Math.round(b.amountCents / b.intervalMonths) : b.amountCents;
}

function intervalLabel(months: number): string {
  switch (months) {
    case 1: return "MONTHLY";
    case 2: return "EVERY 2 MO";
    case 3: return "QUARTERLY";
    case 6: return "EVERY 6 MO";
    case 12: return "ANNUAL";
    default: return `EVERY ${months} MO`;
  }
}

function daysInMonthUtc(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Next occurrence of this bill on or after `today`, derived by walking
 * forward from the anchor in `intervalMonths` steps and clamping the
 * day-of-month to each target month's length.
 */
function nextOccurrence(b: BillRow, today: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b.anchorDate);
  if (!m) return b.anchorDate;
  const aY = Number(m[1]);
  const aM = Number(m[2]);
  const aD = Number(m[3]);
  const tm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!tm) return b.anchorDate;
  const tY = Number(tm[1]);
  const tM = Number(tm[2]);
  const monthsDiff = (tY - aY) * 12 + (tM - aM);
  let k = Math.floor(monthsDiff / b.intervalMonths) - 1;
  for (let i = 0; i < 4096; i++) {
    const total = aY * 12 + (aM - 1) + k * b.intervalMonths;
    const y = Math.floor(total / 12);
    const mo = ((total % 12) + 12) % 12 + 1;
    const d = Math.min(aD, daysInMonthUtc(y, mo));
    const iso = `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (iso >= today) return iso;
    k++;
  }
  return b.anchorDate;
}

export type BillCardOption = { id: string; name: string; isActive: boolean };

export function BillsClient({
  initialBills,
  categories,
  cards,
}: {
  initialBills: BillRow[];
  categories: ReadonlyArray<string>;
  cards: ReadonlyArray<BillCardOption>;
}) {
  const [bills, setBills] = React.useState<BillRow[]>(initialBills);
  const [categoriesState, setCategoriesState] = React.useState<string[]>(() => [...categories]);
  const [showArchived, setShowArchived] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [categoryFilter, setCategoryFilter] = React.useState<string>("ALL");
  const [sortKey, setSortKey] = React.useState<"name" | "amount" | "next" | "monthly">("name");
  const today = todayIso();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<BillRow | null>(null);
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
        case "next": return nextOccurrence(a, today).localeCompare(nextOccurrence(b, today));
        case "monthly": return monthlyEquivalent(a) - monthlyEquivalent(b);
        default: return a.name.localeCompare(b.name);
      }
    });

  const totalAmount = visible.reduce((s, b) => s + b.amountCents, 0);
  const totalMonthly = visible.reduce((s, b) => s + monthlyEquivalent(b), 0);
  const activeCount = bills.filter((b) => b.isActive).length;
  const archivedCount = bills.length - activeCount;

  const allCategories = Array.from(new Set(bills.map((b) => b.category.toUpperCase()))).sort();

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

  return (
    <div className="space-y-6 fade-in">
      <PageHead
        module="MODULE_02"
        title="BILLS"
        subtitle="Recurring expenses · any cycle from monthly to multi-year"
        actions={
          <>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <Switch checked={showArchived} onCheckedChange={setShowArchived} />
              <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]">
                SHOW ARCHIVED
              </span>
            </label>
            <Button variant="outline">
              <Download className="h-3 w-3" /> EXPORT
            </Button>
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3 w-3" /> ADD BILL
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Tab
          active={categoryFilter === "ALL"}
          onClick={() => setCategoryFilter("ALL")}
        >
          ALL · {activeCount}
        </Tab>
        {allCategories.map((c) => (
          <Tab key={c} active={categoryFilter === c} onClick={() => setCategoryFilter(c)}>
            {c}
          </Tab>
        ))}
        <div className="ml-auto w-56">
          <Input
            placeholder="FILTER…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="text-[11px] uppercase tracking-[0.1em]"
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>NO BILLS YET</CardTitle>
          </CardHeader>
          <div className="px-4 py-8 text-center">
            <p className="mb-4 text-[11px] tracking-wide text-[var(--text-2)]">
              Add your first recurring bill to start projecting.
            </p>
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3 w-3" /> ADD YOUR FIRST BILL
            </Button>
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div>
              <CardSubTag>TABLE_BILL</CardSubTag>
              <CardTitle className="mt-0.5">
                {activeCount} ACTIVE · {archivedCount} ARCHIVED
              </CardTitle>
            </div>
            <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]">
              CLICK ROW → EDIT
            </div>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead onClick={() => setSortKey("name")} className="cursor-pointer">
                  NAME ↕
                </TableHead>
                <TableHead>CATEGORY</TableHead>
                <TableHead onClick={() => setSortKey("amount")} className="cursor-pointer text-right">
                  AMOUNT ↕
                </TableHead>
                <TableHead>EVERY</TableHead>
                <TableHead onClick={() => setSortKey("next")} className="cursor-pointer text-right">
                  NEXT DUE ↕
                </TableHead>
                <TableHead>AUTOPAY</TableHead>
                <TableHead onClick={() => setSortKey("monthly")} className="cursor-pointer text-right">
                  MONTHLY EQ ↕
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
                  <TableCell className="font-semibold text-[var(--text-0)]">
                    {b.name}
                    {!b.isActive ? (
                      <Badge variant="muted" className="ml-2">
                        ARCHIVED
                      </Badge>
                    ) : null}
                    {b.paidViaCardId ? (
                      <Badge
                        variant={cardById.get(b.paidViaCardId)?.isActive ? "secondary" : "muted"}
                        className="ml-2"
                        title={
                          cardById.get(b.paidViaCardId)?.isActive
                            ? "Paid via this card — skipped from cash projection"
                            : "Linked card is archived — falling back to cash"
                        }
                      >
                        VIA {cardById.get(b.paidViaCardId)?.name?.toUpperCase() ?? "UNKNOWN"}
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
                  <TableCell className="text-right tabular">
                    <DateLabel iso={nextOccurrence(b, today)} format="short" />
                  </TableCell>
                  <TableCell>
                    <StatusPill variant={b.autoPay ? "default" : "off"}>
                      {b.autoPay ? "ON" : "OFF"}
                    </StatusPill>
                  </TableCell>
                  <TableCell className="text-right text-[var(--mint)] font-semibold">
                    <Money cents={monthlyEquivalent(b)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={2} className="text-[var(--text-0)] uppercase tracking-[0.15em]">
                  TOTAL · {visible.length} ITEMS
                </TableCell>
                <TableCell className="text-right">
                  <Money cents={totalAmount} />
                </TableCell>
                <TableCell colSpan={3} />
                <TableCell className="text-right text-[var(--mint)]">
                  <Money cents={totalMonthly} />
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </Card>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <CardSubTag>NEW_BILL</CardSubTag>
            <DialogTitle>ADD BILL</DialogTitle>
          </DialogHeader>
          <BillForm
            categories={categoriesState}
            cards={cards}
            onCategoryAdded={(c) => setCategoriesState((prev) => [...prev, c])}
            onSubmit={create}
            onCancel={() => setCreateOpen(false)}
            submitting={submitting}
          />
        </DialogContent>
      </Dialog>

      <Sheet open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <SheetContent>
          {editing ? (
            <>
              <SheetHeader>
                <CardSubTag>EDIT_BILL</CardSubTag>
                <SheetTitle>{editing.name.toUpperCase()}</SheetTitle>
              </SheetHeader>
              <SheetBody>
                <BillForm
                  initial={editing}
                  categories={categoriesState}
                  cards={cards}
                  onCategoryAdded={(c) => setCategoriesState((prev) => [...prev, c])}
                  onSubmit={update}
                  onCancel={() => setEditing(null)}
                  submitting={submitting}
                  hideActions
                />
              </SheetBody>
              <SheetFooter>
                {editing.isActive ? (
                  <Button variant="destructive" onClick={() => archive(editing.id)}>
                    SOFT DELETE
                  </Button>
                ) : (
                  <span />
                )}
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setEditing(null)}>
                    CANCEL
                  </Button>
                  <Button
                    variant="primary"
                    form="bill-form"
                    type="submit"
                    disabled={submitting}
                  >
                    {submitting ? "SAVING…" : "SAVE"}
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
        "rounded-sm border px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] transition-colors cursor-pointer font-mono",
        active
          ? "bg-[var(--mint-glow)] text-[var(--mint)] border-[var(--mint-dim)]"
          : "bg-[var(--bg-2)] text-[var(--text-2)] border-[var(--border-raw)] hover:text-[var(--text-0)] hover:border-[var(--border-2)]",
      )}
    >
      {children}
    </button>
  );
}
