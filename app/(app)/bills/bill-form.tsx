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
import { CategoryDialog } from "@/components/category-dialog";
import type { BillRow } from "@/lib/db/schema";

export type BillFormValues = {
  name: string;
  category: string;
  amountCents: number;
  frequency: "monthly" | "annual";
  dueDay: number;
  dueMonth: number | null;
  autoPay: boolean;
  notes: string | null;
};

export function BillForm({
  initial,
  categories,
  onSubmit,
  onCancel,
  submitting,
  hideActions,
  onCategoryAdded,
}: {
  initial?: BillRow;
  categories: ReadonlyArray<string>;
  onSubmit: (values: BillFormValues) => void | Promise<void>;
  onCancel: () => void;
  submitting?: boolean;
  hideActions?: boolean;
  onCategoryAdded?: (name: string) => void;
}) {
  const [name, setName] = React.useState(initial?.name ?? "");
  const [category, setCategory] = React.useState(initial?.category ?? categories[0] ?? "Other");
  const [categoryDialogOpen, setCategoryDialogOpen] = React.useState(false);
  const [amountCents, setAmountCents] = React.useState(initial?.amountCents ?? 0);
  const [frequency, setFrequency] = React.useState<"monthly" | "annual">(initial?.frequency ?? "monthly");
  const [dueDay, setDueDay] = React.useState<number>(initial?.dueDay ?? 1);
  const [dueMonth, setDueMonth] = React.useState<number | null>(initial?.dueMonth ?? null);
  const [autoPay, setAutoPay] = React.useState<boolean>(initial?.autoPay ?? false);
  const [notes, setNotes] = React.useState<string>(initial?.notes ?? "");

  const monthlyEq = frequency === "monthly" ? amountCents : Math.round(amountCents / 12);

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
          frequency,
          dueDay,
          dueMonth: frequency === "annual" ? dueMonth : null,
          autoPay,
          notes: notes.trim() ? notes.trim() : null,
        });
      }}
    >
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="name">NAME</Label>
          <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="amount">AMOUNT ($)</Label>
          <MoneyInput id="amount" valueCents={amountCents} onChangeCents={setAmountCents} />
        </div>
        <div className="space-y-1.5">
          <Label className="flex items-center justify-between">
            <span>CATEGORY</span>
            <button
              type="button"
              onClick={() => setCategoryDialogOpen(true)}
              className="inline-flex items-center gap-1 normal-case tracking-normal text-[10px] text-[var(--mint)] hover:text-[var(--mint-bright)] cursor-pointer"
            >
              <Plus className="h-3 w-3" /> ADD NEW
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
          <Label>FREQUENCY</Label>
          <Select value={frequency} onValueChange={(v) => setFrequency(v as "monthly" | "annual")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="monthly">MONTHLY</SelectItem>
              <SelectItem value="annual">ANNUAL</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dueDay">DUE DAY (1–31)</Label>
          <Input
            id="dueDay"
            type="number"
            min={1}
            max={31}
            required
            value={dueDay}
            onChange={(e) => setDueDay(Number(e.target.value))}
          />
        </div>
        {frequency === "annual" ? (
          <div className="col-span-2 space-y-1.5">
            <Label>DUE MONTH</Label>
            <Select
              value={dueMonth ? String(dueMonth) : ""}
              onValueChange={(v) => setDueMonth(Number(v))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a month" />
              </SelectTrigger>
              <SelectContent>
                {[
                  "January", "February", "March", "April", "May", "June",
                  "July", "August", "September", "October", "November", "December",
                ].map((m, i) => (
                  <SelectItem key={m} value={String(i + 1)}>
                    {m.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="col-span-2">
          <label className="flex cursor-pointer items-center justify-between">
            <Label>AUTOPAY</Label>
            <Switch checked={autoPay} onCheckedChange={setAutoPay} />
          </label>
        </div>
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="notes">NOTES</Label>
          <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="col-span-2 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 py-2.5">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]">
            <span>MONTHLY EQUIVALENT</span>
            <span className="text-[13px] font-bold text-[var(--mint)] tabular">
              <Money cents={monthlyEq} />
            </span>
          </div>
        </div>
      </div>
      {hideActions ? null : (
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            CANCEL
          </Button>
          <Button type="submit" variant="primary" disabled={submitting || !name.trim()}>
            {submitting ? "SAVING…" : "SAVE"}
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
