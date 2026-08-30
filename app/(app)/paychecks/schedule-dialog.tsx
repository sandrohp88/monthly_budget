"use client";

import * as React from "react";
import { toast } from "sonner";
import { ArrowRight, Lock } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/money-input";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import { StatusPill } from "@/components/ui/status-pill";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { describeCadence, type PaycheckCadence, type PaycheckPlan } from "@/lib/paycheck-schedule";
import type { PaycheckRow } from "@/lib/db/schema";

/** The repeat options, in the order people actually reach for them. */
const REPEAT_PRESETS = [
  { value: "14", label: "Every 2 weeks" },
  { value: "7", label: "Every week" },
  { value: "monthly", label: "Once a month" },
  { value: "custom", label: "Every N days…" },
] as const;

export type ScheduleSeed = {
  label: string;
  amountCents: number;
  anchorDate: string;
  cadence: PaycheckCadence | null;
  /** True when editing a run that already exists — changes the wording only. */
  existing: boolean;
};

export function ScheduleDialog({
  open,
  onOpenChange,
  seed,
  defaultMonths,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  seed: ScheduleSeed | null;
  defaultMonths: number;
  onApplied: (paychecks: PaycheckRow[]) => void;
}) {
  const [label, setLabel] = React.useState("");
  const [amountCents, setAmountCents] = React.useState(0);
  const [anchorDate, setAnchorDate] = React.useState("");
  const [repeat, setRepeat] = React.useState<string>("14");
  const [customDays, setCustomDays] = React.useState(14);
  const [months, setMonths] = React.useState(defaultMonths);
  const [pruneExtra, setPruneExtra] = React.useState(false);
  const [plan, setPlan] = React.useState<PaycheckPlan | null>(null);
  const [planning, setPlanning] = React.useState(false);
  const [applying, setApplying] = React.useState(false);

  // Reseed every time the dialog opens so an edit always reflects the run the
  // user clicked, not whatever was last typed.
  React.useEffect(() => {
    if (!open || !seed) return;
    setLabel(seed.label);
    setAmountCents(seed.amountCents);
    setAnchorDate(seed.anchorDate);
    setMonths(defaultMonths);
    setPruneExtra(false);
    setPlan(null);
    const c = seed.cadence;
    if (c?.kind === "monthly") setRepeat("monthly");
    else if (c?.kind === "everyDays" && (c.days === 7 || c.days === 14)) setRepeat(String(c.days));
    else if (c?.kind === "everyDays") {
      setRepeat("custom");
      setCustomDays(c.days);
    } else setRepeat("14");
  }, [open, seed, defaultMonths]);

  const cadence: PaycheckCadence = React.useMemo(() => {
    if (repeat === "monthly") {
      const day = Number(anchorDate.slice(8, 10)) || 1;
      return { kind: "monthly", day };
    }
    if (repeat === "custom") return { kind: "everyDays", days: Math.max(1, customDays) };
    return { kind: "everyDays", days: Number(repeat) };
  }, [repeat, customDays, anchorDate]);

  const body = React.useMemo(
    () => ({
      label: label.trim(),
      amountCents,
      anchorDate,
      cadence,
      months,
      pruneExtra,
    }),
    [label, amountCents, anchorDate, cadence, months, pruneExtra],
  );

  const ready = amountCents > 0 && /^\d{4}-\d{2}-\d{2}$/.test(anchorDate) && months >= 1;

  // Live preview: the whole point of the dialog is that you can see what a
  // change does before it happens, so don't make the user press a button to
  // find out. Debounced so typing an amount doesn't spam the route.
  React.useEffect(() => {
    if (!open || !ready) {
      setPlan(null);
      return;
    }
    let cancelled = false;
    setPlanning(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/paychecks/schedule", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error("preview failed");
        const json = await res.json();
        if (!cancelled) setPlan(json.plan);
      } catch {
        if (!cancelled) setPlan(null);
      } finally {
        if (!cancelled) setPlanning(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, ready, body]);

  const apply = async () => {
    setApplying(true);
    try {
      const res = await fetch("/api/paychecks/schedule?apply=true", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("could not save the schedule");
      const json = await res.json();
      onApplied(json.paychecks ?? []);
      const n = json.plan?.entries?.length ?? 0;
      toast.success(n === 0 ? "Schedule already up to date" : `${n} paycheck${n === 1 ? "" : "s"} updated`);
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const entries = plan?.entries ?? [];
  const counts = {
    add: entries.filter((e) => e.action === "add").length,
    update: entries.filter((e) => e.action === "update").length,
    move: entries.filter((e) => e.action === "move").length,
    remove: entries.filter((e) => e.action === "remove").length,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {seed?.existing
              ? `Edit ${seed.label || "main"} paycheck schedule`
              : "New paycheck schedule"}
          </DialogTitle>
          <DialogDescription>
            Set the pattern once and the paychecks are laid out for you. Nothing is saved until you
            press Apply, and paychecks you&apos;ve already received are never changed.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sched-amount">Amount each payday</Label>
            <MoneyInput valueCents={amountCents} onChangeCents={setAmountCents} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sched-label">Whose paycheck</Label>
            <Input
              id="sched-label"
              value={label}
              maxLength={120}
              placeholder="Leave blank for yours"
              onChange={(e) => setLabel(e.target.value)}
              disabled={seed?.existing}
            />
            <p className="text-2xs text-[var(--text-3)]">
              {seed?.existing
                ? "Renaming a run isn't a schedule change — edit the rows to move them."
                : "A name keeps a second earner's paychecks on their own schedule."}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Repeats</Label>
            <Select value={repeat} onValueChange={setRepeat}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPEAT_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            {repeat === "custom" ? (
              <>
                <Label htmlFor="sched-days">Days between paydays</Label>
                <Input
                  id="sched-days"
                  type="number"
                  min={1}
                  max={90}
                  value={customDays}
                  onChange={(e) => setCustomDays(Number(e.target.value))}
                />
              </>
            ) : (
              <>
                <Label htmlFor="sched-anchor">
                  {repeat === "monthly" ? "Payday each month" : "A payday to count from"}
                </Label>
                <Input
                  id="sched-anchor"
                  type="date"
                  value={anchorDate}
                  onChange={(e) => setAnchorDate(e.target.value)}
                />
              </>
            )}
          </div>

          {repeat === "custom" ? (
            <div className="space-y-1.5">
              <Label htmlFor="sched-anchor-2">A payday to count from</Label>
              <Input
                id="sched-anchor-2"
                type="date"
                value={anchorDate}
                onChange={(e) => setAnchorDate(e.target.value)}
              />
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="sched-months">Plan ahead</Label>
            <Input
              id="sched-months"
              type="number"
              min={1}
              max={36}
              value={months}
              onChange={(e) => setMonths(Number(e.target.value))}
            />
            <p className="text-2xs text-[var(--text-3)]">months of paychecks to lay out</p>
          </div>
        </div>

        <p className="rounded-md border border-[var(--border-raw)] bg-[var(--bg-1)] px-3 py-2 text-[11px] text-[var(--text-2)]">
          <Money cents={amountCents} />{" "}
          <span className="text-[var(--text-3)]">·</span> {describeCadence(cadence)}{" "}
          <span className="text-[var(--text-3)]">·</span> {months} month
          {months === 1 ? "" : "s"} ahead
        </p>

        {/* What will actually happen. Shown before anything is written. */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>What this will do</Label>
            {planning ? <span className="text-2xs text-[var(--text-3)]">working…</span> : null}
          </div>

          {!ready ? (
            <p className="rounded-md border border-dashed border-[var(--border-raw)] px-3 py-6 text-center text-[11px] text-[var(--text-3)]">
              Enter an amount and a payday to see the plan.
            </p>
          ) : entries.length === 0 && !planning ? (
            <p className="rounded-md border border-[var(--border-raw)] bg-[var(--bg-1)] px-3 py-6 text-center text-[11px] text-[var(--text-2)]">
              Nothing to change — these paychecks already match this schedule.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {counts.add > 0 ? (
                  <StatusPill variant="default">{counts.add} added</StatusPill>
                ) : null}
                {counts.update > 0 ? (
                  <StatusPill variant="warn">{counts.update} amount changed</StatusPill>
                ) : null}
                {counts.move > 0 ? (
                  <StatusPill variant="warn">{counts.move} moved</StatusPill>
                ) : null}
                {counts.remove > 0 ? (
                  <StatusPill variant="off">{counts.remove} removed</StatusPill>
                ) : null}
              </div>
              <div className="max-h-56 overflow-y-auto rounded-md border border-[var(--border-raw)]">
                <table className="w-full text-[11px] tabular">
                  <tbody>
                    {entries.map((e, i) => (
                      <tr
                        key={`${e.action}-${e.payDate}-${i}`}
                        className="border-b border-[var(--border-raw)] last:border-0"
                      >
                        <td className="px-3 py-1.5 w-24 text-[var(--text-3)]">
                          {e.action === "add"
                            ? "Add"
                            : e.action === "update"
                              ? "Change"
                              : e.action === "move"
                                ? "Move"
                                : "Remove"}
                        </td>
                        <td className="px-3 py-1.5">
                          {e.action === "move" ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="text-[var(--text-3)] line-through">
                                <DateLabel iso={e.fromPayDate} format="short" />
                              </span>
                              <ArrowRight className="h-3 w-3 text-[var(--text-3)]" />
                              <DateLabel iso={e.payDate} format="short" />
                            </span>
                          ) : (
                            <DateLabel iso={e.payDate} format="short" />
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          {e.action === "update" ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="text-[var(--text-3)] line-through">
                                <Money cents={e.fromAmountCents} />
                              </span>
                              <ArrowRight className="h-3 w-3 text-[var(--text-3)]" />
                              <Money cents={e.amountCents} />
                            </span>
                          ) : (
                            <Money cents={e.amountCents} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {plan && plan.protectedCount > 0 ? (
            <p className="flex items-center gap-1.5 text-2xs text-[var(--text-3)]">
              <Lock className="h-3 w-3" />
              {plan.protectedCount} already received or in the past — left untouched.
            </p>
          ) : null}
        </div>

        <div className="flex items-start justify-between gap-4 rounded-md border border-[var(--border-raw)] px-3 py-2">
          <div>
            <div className="text-[11px] text-[var(--text-1)]">Tidy up extra paydays</div>
            <p className="text-2xs text-[var(--text-3)]">
              Remove upcoming paychecks in this run that don&apos;t fit the pattern.
            </p>
          </div>
          <Switch checked={pruneExtra} onCheckedChange={setPruneExtra} />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={apply}
            disabled={!ready || applying || planning || entries.length === 0}
          >
            {applying ? "Saving…" : `Apply ${entries.length || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
