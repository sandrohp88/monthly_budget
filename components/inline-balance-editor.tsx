"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { Money } from "@/components/money";
import { dollarsToCents } from "@/lib/money";
import { cn } from "@/lib/cn";

/**
 * Click-to-edit current balance for MANUAL credit cards (linked cards sync
 * their balance from Plaid — editing those would be overwritten and lie).
 * Renders the balance with a pencil affordance; click swaps in a small input.
 * Enter/blur saves via PATCH /api/credit-cards/[id]; Escape cancels.
 */
export function InlineBalanceEditor({
  cardId,
  valueCents,
  textClassName,
  inputClassName,
}: {
  cardId: string;
  /** Displayed balance (may be a computed fallback when nothing is tracked). */
  valueCents: number | null;
  textClassName?: string;
  inputClassName?: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const startEditing = (e: React.MouseEvent) => {
    // The wallet entry is wrapped in a Link — don't navigate.
    e.preventDefault();
    e.stopPropagation();
    setText(valueCents != null && valueCents !== 0 ? (valueCents / 100).toFixed(2) : "");
    setEditing(true);
  };

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const save = async () => {
    if (saving) return;
    let cents: number;
    try {
      cents = text.trim() === "" ? 0 : dollarsToCents(text.trim());
    } catch {
      toast.error("Enter a valid amount");
      inputRef.current?.focus();
      return;
    }
    if (cents === valueCents) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/credit-cards/${cardId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentBalanceCents: cents }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "save failed");
      }
      toast.success("Balance updated");
      setEditing(false);
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={startEditing}
        title="Edit balance"
        className={cn(
          "group/balance inline-flex cursor-pointer items-center gap-1 rounded-sm tabular",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mint-dim)]",
          textClassName,
        )}
      >
        {valueCents != null ? (
          <Money cents={valueCents} />
        ) : (
          <span className="font-medium text-[var(--text-3)]">—</span>
        )}
        <Pencil className="h-3 w-3 shrink-0 text-[var(--text-3)] opacity-40 transition-opacity group-hover/balance:opacity-100" />
      </button>
    );
  }

  return (
    <span
      className="inline-flex items-center"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <input
        ref={inputRef}
        inputMode="decimal"
        value={text}
        disabled={saving}
        placeholder="0.00"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        onBlur={() => void save()}
        className={cn(
          "h-7 w-24 rounded-[8px] border border-[var(--mint-dim)] bg-[var(--bg-1)] px-2",
          "text-right text-[13px] font-semibold tabular text-[var(--text-0)]",
          "focus:outline-none focus:ring-2 focus:ring-[var(--mint-dim)]",
          inputClassName,
        )}
      />
    </span>
  );
}
