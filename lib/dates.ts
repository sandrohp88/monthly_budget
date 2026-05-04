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

/** First day of the month containing `iso`, as ISO YYYY-MM-DD. */
export function startOfMonthIso(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
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
  // We construct in UTC, so we MUST format via UTC accessors. date-fns
  // `format()` uses local time and would silently drop a day in negative-UTC
  // zones (e.g. EST renders Jan 31 00:00 UTC as Jan 30). toISOString() is
  // timezone-stable: always renders the absolute UTC instant.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months + 1, 0));
  return target.toISOString().slice(0, 10);
}

export { DAY_MS };
