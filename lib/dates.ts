import { format, parseISO, addDays, differenceInCalendarDays } from "date-fns";

const DAY_MS = 86_400_000;

/** Format an ISO date string for display. `format` defaults to "long". */
export function formatIso(iso: string, fmt: "long" | "short" | "iso" = "long"): string {
  if (fmt === "iso") return iso;
  const d = parseISO(iso);
  return format(d, fmt === "long" ? "EEE, MMM d, yyyy" : "MMM d");
}

/** Today's calendar date in the configured timezone, as ISO YYYY-MM-DD. */
export function todayIso(timeZone = "America/New_York"): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(now);
}

/** Add a number of days to an ISO date, returning a new ISO date. */
export function addDaysIso(iso: string, days: number): string {
  const d = parseISO(iso);
  return format(addDays(d, days), "yyyy-MM-dd");
}

/** Number of calendar days between two ISO dates (b - a). */
export function daysBetween(a: string, b: string): number {
  return differenceInCalendarDays(parseISO(b), parseISO(a));
}

/** End of month N months after `iso` (still ISO YYYY-MM-DD). */
export function endOfMonthsAhead(iso: string, months: number): string {
  const d = parseISO(iso);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months + 1, 0));
  return format(target, "yyyy-MM-dd");
}

export { DAY_MS };
