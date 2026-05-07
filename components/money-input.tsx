"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { dollarsToCents } from "@/lib/money";

/**
 * Controlled money input. Stores cents externally; renders dollars.
 *
 * Parsing routes through `dollarsToCents`, which is string-based so the
 * IEEE-754 trap (1.005 × 100 ≠ 100.5) doesn't drop a cent on the floor.
 */
export const MoneyInput = React.forwardRef<
  HTMLInputElement,
  {
    valueCents: number;
    onChangeCents: (cents: number) => void;
    name?: string;
    id?: string;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
  }
>(({ valueCents, onChangeCents, ...rest }, ref) => {
  const [text, setText] = React.useState<string>(() =>
    valueCents === 0 ? "" : (valueCents / 100).toFixed(2),
  );

  React.useEffect(() => {
    const next = valueCents === 0 ? "" : (valueCents / 100).toFixed(2);
    setText((prev) => {
      try {
        const prevCents = prev === "" || prev === "-" ? 0 : dollarsToCents(prev);
        return prevCents === valueCents ? prev : next;
      } catch {
        return next;
      }
    });
  }, [valueCents]);

  return (
    <Input
      ref={ref}
      inputMode="decimal"
      {...rest}
      value={text}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        const cleaned = v.replace(/[$,\s]/g, "");
        if (cleaned === "" || cleaned === "-") {
          onChangeCents(0);
          return;
        }
        try {
          onChangeCents(dollarsToCents(cleaned));
        } catch {
          // Mid-typing states like "1." or "-." aren't valid money strings;
          // leave the displayed text alone and don't mutate the parent value.
        }
      }}
    />
  );
});
MoneyInput.displayName = "MoneyInput";
