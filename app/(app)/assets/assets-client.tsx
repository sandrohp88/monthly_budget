"use client";

import * as React from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { CardSubTag, PageHead } from "@/components/ui/page-head";
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
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { todayIso } from "@/lib/dates";
import type { AssetRow } from "@/lib/db/schema";

const ASSET_CATEGORIES = [
  { value: "real_estate", label: "REAL ESTATE" },
  { value: "vehicle", label: "VEHICLE" },
  { value: "investment", label: "INVESTMENT" },
  { value: "savings", label: "SAVINGS" },
  { value: "retirement", label: "RETIREMENT" },
  { value: "crypto", label: "CRYPTO" },
  { value: "other", label: "OTHER" },
] as const;

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  ASSET_CATEGORIES.map((c) => [c.value, c.label]),
);

function categoryLabel(cat: string): string {
  return CATEGORY_LABEL[cat] ?? cat.toUpperCase();
}

export function AssetsClient({
  initialAssets,
}: {
  initialAssets: AssetRow[];
}) {
  const [items, setItems] = React.useState<AssetRow[]>(initialAssets);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AssetRow | null>(null);

  const totalCents = items.reduce((s, a) => s + a.valueCents, 0);
  const categoryCount = new Set(items.map((a) => a.category)).size;
  const largest = items.reduce<AssetRow | null>(
    (best, a) => (!best || a.valueCents > best.valueCents ? a : best),
    null,
  );

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key === "n") {
        e.preventDefault();
        setEditing(null);
        setDialogOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const remove = async (id: string) => {
    const prev = items;
    setItems((curr) => curr.filter((a) => a.id !== id));
    try {
      const res = await fetch(`/api/assets/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      toast.success("Asset archived");
    } catch (err) {
      setItems(prev);
      toast.error((err as Error).message);
    }
  };

  const openEdit = (asset: AssetRow) => {
    setEditing(asset);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-6 fade-in">
      <PageHead
        module="MODULE_09"
        title="ASSETS"
        subtitle="Track asset values for net worth calculation"
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="h-3 w-3" /> ADD ASSET
          </Button>
        }
      />

      <TileGrid cols={3}>
        <Tile
          label="TOTAL ASSETS"
          value={<Money cents={totalCents} />}
          delta={`${items.length} asset${items.length === 1 ? "" : "s"}`}
        />
        <Tile
          label="LARGEST"
          value={
            largest ? (
              <Money cents={largest.valueCents} />
            ) : (
              <span className="text-[var(--text-2)] text-base">&mdash;</span>
            )
          }
          delta={largest ? largest.name : "no assets"}
        />
        <Tile label="CATEGORIES" value={categoryCount} delta="distinct" />
      </TileGrid>

      {items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>NO ASSETS TRACKED</CardTitle>
          </CardHeader>
          <div className="px-4 py-8 text-center">
            <p className="mb-4 text-[11px] tracking-wide text-[var(--text-2)]">
              Add assets like property, vehicles, or investments to track net
              worth.
            </p>
            <Button
              variant="primary"
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-3 w-3" /> ADD ASSET
            </Button>
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div>
              <CardSubTag>TABLE_ASSETS</CardSubTag>
              <CardTitle className="mt-0.5">TRACKED ASSETS</CardTitle>
            </div>
          </CardHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>NAME</TableHead>
                <TableHead>CATEGORY</TableHead>
                <TableHead>AS OF</TableHead>
                <TableHead className="text-right">VALUE</TableHead>
                <TableHead>NOTES</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-semibold text-[var(--text-0)]">
                    {a.name}
                  </TableCell>
                  <TableCell>
                    <Badge variant="muted">{categoryLabel(a.category)}</Badge>
                  </TableCell>
                  <TableCell>
                    <DateLabel iso={a.asOfDate} format="short" />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money cents={a.valueCents} />
                  </TableCell>
                  <TableCell className="text-[var(--text-2)]">
                    {a.notes ?? ""}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Edit"
                        onClick={() => openEdit(a)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Archive"
                        onClick={() => remove(a.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell
                  colSpan={3}
                  className="text-[var(--text-0)] uppercase tracking-[0.15em]"
                >
                  TOTAL &middot; {items.length} ASSET
                  {items.length === 1 ? "" : "S"}
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

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <CardSubTag>{editing ? "EDIT_ASSET" : "NEW_ASSET"}</CardSubTag>
            <DialogTitle>
              {editing ? "EDIT ASSET" : "ADD ASSET"}
            </DialogTitle>
          </DialogHeader>
          <AssetForm
            initial={editing}
            onCancel={() => {
              setDialogOpen(false);
              setEditing(null);
            }}
            onSaved={(saved) => {
              if (editing) {
                setItems((prev) =>
                  prev.map((a) => (a.id === saved.id ? saved : a)),
                );
              } else {
                setItems((prev) =>
                  [...prev, saved].sort(
                    (a, b) => b.valueCents - a.valueCents,
                  ),
                );
              }
              setDialogOpen(false);
              setEditing(null);
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AssetForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial: AssetRow | null;
  onCancel: () => void;
  onSaved: (a: AssetRow) => void;
}) {
  const today = todayIso();
  const [name, setName] = React.useState(initial?.name ?? "");
  const [valueCents, setValueCents] = React.useState(
    initial?.valueCents ?? 0,
  );
  const [category, setCategory] = React.useState(
    initial?.category ?? "other",
  );
  const [notes, setNotes] = React.useState(initial?.notes ?? "");
  const [asOfDate, setAsOfDate] = React.useState(
    initial?.asOfDate ?? today,
  );
  const [submitting, setSubmitting] = React.useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setSubmitting(true);
        try {
          const isEdit = !!initial;
          const url = isEdit
            ? `/api/assets/${initial.id}`
            : "/api/assets";
          const method = isEdit ? "PATCH" : "POST";
          const res = await fetch(url, {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: name.trim(),
              valueCents,
              category,
              notes: notes.trim() || null,
              asOfDate,
            }),
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error ?? "save failed");
          onSaved(json.asset as AssetRow);
          toast.success(isEdit ? "Asset updated" : "Asset added");
        } catch (err) {
          toast.error((err as Error).message);
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="name">NAME</Label>
          <Input
            id="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. House, Car, 401(k)"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="value">VALUE ($)</Label>
          <MoneyInput
            id="value"
            valueCents={valueCents}
            onChangeCents={setValueCents}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="asOfDate">AS OF DATE</Label>
          <Input
            id="asOfDate"
            type="date"
            required
            value={asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
          />
        </div>
        <div className="col-span-2 space-y-1.5">
          <Label>CATEGORY</Label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ASSET_CATEGORIES.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="col-span-2 space-y-1.5">
          <Label htmlFor="notes">NOTES</Label>
          <Input
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional notes"
          />
        </div>
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={submitting}
        >
          CANCEL
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={submitting || !name.trim()}
        >
          {submitting ? "SAVING…" : "SAVE"}
        </Button>
      </DialogFooter>
    </form>
  );
}
