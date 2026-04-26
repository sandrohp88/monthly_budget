"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";

/**
 * Controlled money input. Stores cents externally; renders dollars.
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
    setText((prev) => (Math.round(Number(prev || "0") * 100) === valueCents ? prev : next));
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
        const n = Number(cleaned);
        if (Number.isFinite(n)) onChangeCents(Math.round(n * 100));
      }}
    />
  );
});
MoneyInput.displayName = "MoneyInput";
