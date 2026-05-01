"use client";

import * as React from "react";
import { formatCents } from "@/lib/money";
import { useCurrency } from "@/components/currency-provider";
import { cn } from "@/lib/cn";

export function Money({
  cents,
  className,
  signed = false,
  colorize = false,
}: {
  cents: number;
  className?: string;
  signed?: boolean;
  colorize?: boolean;
}) {
  const currency = useCurrency();
  const value = formatCents(Math.abs(cents), currency);
  const display = cents < 0 ? `-${value}` : signed && cents > 0 ? `+${value}` : value;
  // Money is "data" per the Home Apps spec — render in JetBrains Mono.
  // The .tabular class applies both font-mono and font-variant-numeric.
  const color = colorize ? (cents < 0 ? "text-destructive" : cents > 0 ? "text-emerald-600" : "") : "";
  return (
    <span className={cn("tabular", color, className)}>{display}</span>
  );
}
