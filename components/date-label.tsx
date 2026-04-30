import { formatIso } from "@/lib/dates";
import { cn } from "@/lib/cn";

// Dates are "data" per the Home Apps design system — render in JetBrains
// Mono via the .tabular class so they stay aligned and visually anchored
// to numbers (money, durations, etc.).
export function DateLabel({
  iso,
  format = "long",
  className,
}: {
  iso: string;
  format?: "long" | "short" | "iso";
  className?: string;
}) {
  return <span className={cn("tabular", className)}>{formatIso(iso, format)}</span>;
}
