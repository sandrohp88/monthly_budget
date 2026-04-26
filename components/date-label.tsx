import { formatIso } from "@/lib/dates";

export function DateLabel({
  iso,
  format = "long",
  className,
}: {
  iso: string;
  format?: "long" | "short" | "iso";
  className?: string;
}) {
  return <span className={className}>{formatIso(iso, format)}</span>;
}
