"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { MoneyInput } from "@/components/money-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Money } from "@/components/money";
import { nextBillOccurrence } from "@/lib/bills";
import { CategoryDialog } from "@/components/category-dialog";
import { todayIso } from "@/lib/dates";
import type { BillRow } from "@/lib/db/schema";

export type BillFormValues = {
  name: string;
  category: string;
  amountCents: number;
  intervalMonths: number;
  anchorDate: string;
  autoPay: boolean;
  paidViaCardId: string | null;
  notes: string | null;
};

const CASH_OPTION = "__cash__";
const CUSTOM_PRESET = "custom";

const INTERVAL_PRESETS: ReadonlyArray<{ value: string; months: number; label: string }> = [
  { value: "1", months: 1, label: "Monthly" },
  { value: "2", months: 2, label: "Every 2 months" },
  { value: "3", months: 3, label: "Quarterly (3 mo)" },
  { value: "6", months: 6, label: "Every 6 months" },
  { value: "12", months: 12, label: "Annual" },
  { value: CUSTOM_PRESET, months: 0, label: "Custom…" },
];

function presetForMonths(m: number): string {
  return INTERVAL_PRESETS.find((p) => p.months === m)?.value ?? CUSTOM_PRESET;
}

export function BillForm({
  initial,
  categories,
  cards,
  timezone,
  onSubmit,
  onCancel,
  submitting,
  hideActions,
  onCategoryAdded,
  defaultAnchorDate,
}: {
  initial?: BillRow;
  categories: ReadonlyArray<string>;
  cards: ReadonlyArray<{ id: string; name: string; isActive: boolean }>;
  timezone: string;
  onSubmit: (values: BillFormValues) => void | Promise<void>;
  onCancel: () => void;
  submitting?: boolean;
  hideActions?: boolean;
  onCategoryAdded?: (name: string) => void;
  /** Prefill for the next-due-date field when creating (e.g. calendar day click). */
  defaultAnchorDate?: string;
}) {
  const [name, setName] = React.useState(initial?.name ?? "");
  const [category, setCategory] = React.useState(initial?.category ?? categories[0] ?? "Other");
  const [categoryDialogOpen, setCategoryDialogOpen] = React.useState(false);
  const [amountCents, setAmountCents] = React.useState(initial?.amountCents ?? 0);
  const [intervalMonths, setIntervalMonths] = React.useState<number>(initial?.intervalMonths ?? 1);
  const [intervalPreset, setIntervalPreset] = React.useState<string>(
    initial ? presetForMonths(initial.intervalMonths) : "1",
  );
  const today = todayIso(timezone);
  const [anchorDate, setAnchorDate] = React.useState<string>(
    initial ? nextBillOccurrence(initial, today) : (defaultAnchorDate ?? today),
  );
  const [autoPay, setAutoPay] = React.useState<boolean>(initial?.autoPay ?? false);
  const [paidViaCardId, setPaidViaCardId] = React.useState<string>(
    initial?.paidViaCardId ?? CASH_OPTION,
  );
  const [notes, setNotes] = React.useState<string>(initial?.notes ?? "");

  // The list to render in the dropdown: keep an archived linked card visible
  // so the user can see the existing link before deciding to switch it.
  const cardOptions = React.useMemo(() => {
    const active = cards.filter((c) => c.isActive);
    const linkedArchived =
      paidViaCardId !== CASH_OPTION && !cards.find((c) => c.id === paidViaCardId && c.isActive)
        ? cards.find((c) => c.id === paidViaCardId)
        : null;
    return linkedArchived ? [...active, linkedArchived] : active;
  }, [cards, paidViaCardId]);

  const monthlyEq = intervalMonths > 0 ? Math.round(amountCents / intervalMonths) : amountCents;

  const onPresetChange = (v: string) => {
    setIntervalPreset(v);
    if (v !== CUSTOM_PRESET) {
      const m = Number(v);
      if (Number.isFinite(m) && m > 0) setIntervalMonths(m);
    }
  };

  return (
    <form
      id="bill-form"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          name: name.trim(),
          category,
          amountCents,
          intervalMonths,
          anchorDate,
          autoPay,
          paidViaCardId: paidViaCardId === CASH_OPTION ? null : paidViaCardId,
          notes: notes.trim() ? notes.trim() : null,
        });
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="amount">Amount ($)</Label>
          <MoneyInput id="amount" valueCents={amountCents} onChangeCents={setAmountCents} />
        </div>
        <div className="space-y-1.5">
          <Label className="flex items-center justify-between">
            <span>Category</span>
            <button
              type="button"
              onClick={() => setCategoryDialogOpen(true)}
              className="inline-flex items-center gap-1 tracking-normal text-2xs text-[var(--mint)] hover:text-[var(--mint-bright)] cursor-pointer"
            >
              <Plus className="h-3 w-3" /> Add new
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
        <div className="space-y-1.5">
          <Label>Frequency</Label>
          <Select value={intervalPreset} onValueChange={onPresetChange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INTERVAL_PRESETS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="anchorDate">Next due date</Label>
          <Input
            id="anchorDate"
            type="date"
            required
            value={anchorDate}
            onChange={(e) => setAnchorDate(e.target.value)}
          />
        </div>
        {intervalPreset === CUSTOM_PRESET ? (
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="intervalMonths">Every N months</Label>
            <Input
              id="intervalMonths"
              type="number"
              min={1}
              max={120}
              required
              value={intervalMonths}
              onChange={(e) => setIntervalMonths(Math.max(1, Number(e.target.value) || 1))}
            />
            <p className="text-2xs text-[var(--text-3)]">
              1 = monthly · 12 = annual · 24 = every 2 years · etc.
            </p>
          </div>
        ) : null}
        <div className="col-span-1 space-y-1.5 sm:col-span-2">
          <Label>Paid via</Label>
          <Select value={paidViaCardId} onValueChange={setPaidViaCardId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CASH_OPTION}>Bank / cash</SelectItem>
              {cardOptions.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                  {!c.isActive ? " (archived)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-2xs text-[var(--text-3)]">
            {paidViaCardId === CASH_OPTION
              ? "Deducts from balance on due day"
              : cards.find((c) => c.id === paidViaCardId)?.isActive
                ? "Skipped from cash projection — captured by the card's statement"
                : "Linked card is archived — falling back to cash deduction"}
          </p>
        </div>
        <div className="col-span-1 sm:col-span-2">
          <label className="flex cursor-pointer items-center justify-between">
            <Label>Autopay</Label>
            <Switch checked={autoPay} onCheckedChange={setAutoPay} />
          </label>
        </div>
        <div className="col-span-1 space-y-1.5 sm:col-span-2">
          <Label htmlFor="notes">Notes</Label>
          <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="col-span-1 rounded-md border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 py-2.5 sm:col-span-2">
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
          <Button type="submit" variant="primary" disabled={submitting || !name.trim()}>
            {submitting ? "Saving…" : "Save"}
          </Button>
        </div>
      )}

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
