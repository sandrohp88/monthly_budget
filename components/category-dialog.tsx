"use client";

import * as React from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/cn";
import type { CategoryRow } from "@/lib/db/schema";

const PALETTE = [
  "#4ade80", "#22c55e", "#16a34a", "#14b8a6",
  "#06b6d4", "#0ea5e9", "#2563eb", "#7c3aed",
  "#a855f7", "#ec4899", "#ef4444", "#f97316",
  "#eab308", "#fbbf24", "#6b7280",
];

export function CategoryDialog({
  open,
  onClose,
  onCreated,
  defaultKind = "expense",
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (c: CategoryRow) => void;
  defaultKind?: "expense" | "income";
}) {
  const [name, setName] = React.useState("");
  const [color, setColor] = React.useState(PALETTE[0]!);
  const [kind, setKind] = React.useState<"expense" | "income">(defaultKind);
  const [saving, setSaving] = React.useState(false);

  // Reset when dialog opens
  React.useEffect(() => {
    if (open) {
      setName("");
      setColor(PALETTE[0]!);
      setKind(defaultKind);
      setSaving(false);
    }
  }, [open, defaultKind]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), color, kind }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "create failed");
      toast.success(`Category "${name.trim()}" added`);
      onCreated(json.category as CategoryRow);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add category</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label htmlFor="cat-name">Name</Label>
            <Input
              id="cat-name"
              required
              maxLength={50}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label>Kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as "expense" | "income")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="expense">Expense</SelectItem>
                <SelectItem value="income">Income</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-2">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={cn(
                    "h-7 w-7 rounded-sm border-2 transition-all cursor-pointer",
                    color === c
                      ? "border-[var(--text-0)] scale-110"
                      : "border-[var(--border-raw)] hover:border-[var(--border-2)]",
                  )}
                  style={{ background: c }}
                  aria-label={`color ${c}`}
                />
              ))}
            </div>
            <div className="mt-1 flex items-center gap-2 text-2xs text-[var(--text-3)]">
              <span className="h-3 w-3 rounded-sm border border-[var(--border-raw)]" style={{ background: color }} />
              <span className="tabular">{color}</span>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
              {saving ? "Saving…" : "Add category"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
