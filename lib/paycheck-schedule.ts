/**
 * Paycheck schedules: read the cadence out of existing rows, generate a run of
 * future dates, and diff the two into a plan the user can look at before
 * anything is written.
 *
 * Why this exists: the cadence used to live in Settings as three loose fields
 * (`defaultPaycheckCents`, `firstPaydayDate`, `payFrequencyDays`) feeding one
 * opaque "Regen from settings" button that could only ADD missing dates. It
 * could not restate an amount, could not re-space a run whose anchor had been
 * nudged by hand, and had no concept of a second earner — so a household with
 * two incomes kept one in the generator and maintained the other row by row.
 *
 * A SEQUENCE here is just "the paychecks sharing a label", where the label is
 * the row's `note` (empty note = the unlabelled/main sequence). That is how the
 * data already reads in practice, so no migration is needed and existing rows
 * group themselves.
 *
 * Pure — no I/O, no clock. `today` is always passed in.
 */

import type { PaycheckRow } from "./db/schema";

const DAY_MS = 86_400_000;

/** How a run repeats. `everyDays` covers weekly/biweekly; `monthly` the 1st-of-month case. */
export type PaycheckCadence =
  | { kind: "everyDays"; days: number }
  | { kind: "monthly"; day: number };

export type PaycheckSequence = {
  /** The row `note`, or "" for the unlabelled sequence. */
  label: string;
  /** Best-guess cadence read from the upcoming rows; null when unreadable. */
  cadence: PaycheckCadence | null;
  /** The amount that repeats most often among upcoming rows. */
  amountCents: number;
  /** Rows still ahead and unreconciled — the only ones a schedule edit may touch. */
  upcomingCount: number;
  /** Rows already received or in the past. Never touched; surfaced so the UI can say so. */
  settledCount: number;
  nextPayDate: string | null;
  lastPayDate: string | null;
};

export const UNLABELLED = "";

/** Normalize a row's note into a sequence label. */
export function sequenceLabel(note: string | null | undefined): string {
  return (note ?? "").trim();
}

/**
 * A row is editable by a schedule change only while it is BOTH in the future
 * and unreconciled. A received paycheck is a record of something that happened;
 * a past one is history. Restating either from a schedule would be rewriting
 * the past to match a plan.
 */
export function isSchedulable(p: PaycheckRow, today: string): boolean {
  return p.isActive && !p.actualReceived && p.payDate >= today;
}

function parseIso(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function formatIso(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

function daysInMonthUtc(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** The most common value in a list; ties break toward the larger value. */
function mode(values: number[]): number | null {
  if (values.length === 0) return null;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && best != null && v > best)) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/**
 * Read the cadence out of a run of dates.
 *
 * Monthly is checked first and separately from day-gaps: month lengths make a
 * monthly run land on gaps of 28-31 days, so a naive "most common gap" reads a
 * perfectly regular monthly series as noise. A run whose dates all share one
 * day-of-month IS monthly, whatever the day counts say.
 */
export function inferCadence(dates: readonly string[]): PaycheckCadence | null {
  if (dates.length < 2) return null;
  const sorted = [...dates].sort();

  const days = sorted.map((d) => Number(d.slice(8, 10)));
  const uniqueDays = new Set(days);
  if (uniqueDays.size === 1) {
    // Every date on the same day-of-month. Confirm the months actually step by
    // one, so a coincidental pair (Jan 1, Jun 1) isn't read as monthly.
    const months = sorted.map((d) => {
      const [y, m] = d.split("-").map(Number);
      return y! * 12 + m!;
    });
    const steps = months.slice(1).map((m, i) => m - months[i]!);
    if (steps.every((s) => s === 1)) return { kind: "monthly", day: days[0]! };
  }

  const gaps = sorted
    .slice(1)
    .map((d, i) => Math.round((parseIso(d) - parseIso(sorted[i]!)) / DAY_MS));
  if (gaps.length === 0) return null;
  // A repeated gap is the cadence. With no repeat, take the MEDIAN rather than
  // the mode: a run with one date nudged by hand reads 14/13/15, where every
  // gap is unique and picking any single one is arbitrary — the median lands on
  // the true cadence while an outlier can only drag it by one position.
  const counts = new Map<number, number>();
  for (const g of gaps) counts.set(g, (counts.get(g) ?? 0) + 1);
  const repeated = mode(gaps);
  const best =
    repeated != null && (counts.get(repeated) ?? 0) > 1
      ? repeated
      : [...gaps].sort((a, b) => a - b)[Math.floor((gaps.length - 1) / 2)]!;
  if (best <= 0) return null;
  return { kind: "everyDays", days: best };
}

/** Human wording for a cadence — shared by the dialog and the summary row. */
export function describeCadence(cadence: PaycheckCadence | null): string {
  if (!cadence) return "irregular";
  if (cadence.kind === "monthly") {
    return `monthly on the ${ordinal(cadence.day)}`;
  }
  if (cadence.days === 7) return "weekly";
  if (cadence.days === 14) return "every 2 weeks";
  return `every ${cadence.days} days`;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * Dates for a run, from `anchor`, covering `from`..`through` inclusive.
 *
 * The anchor sets the PHASE, not the start: a run anchored in the past still
 * produces the right future dates. Monthly clamps to the month's length, so a
 * 31st anchor lands on the 30th in September and February's last day.
 */
export function generateDates(opts: {
  anchor: string;
  cadence: PaycheckCadence;
  from: string;
  through: string;
}): string[] {
  const { anchor, cadence, from, through } = opts;
  if (through < from) return [];
  const out: string[] = [];

  if (cadence.kind === "monthly") {
    const [fy, fm] = from.split("-").map(Number);
    let year = fy!;
    let month = fm!;
    for (let i = 0; i < 1200; i++) {
      const day = Math.min(cadence.day, daysInMonthUtc(year, month));
      const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(
        day,
      ).padStart(2, "0")}`;
      if (iso > through) break;
      if (iso >= from) out.push(iso);
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    return out;
  }

  const step = Math.max(1, cadence.days) * DAY_MS;
  const anchorTs = parseIso(anchor);
  const fromTs = parseIso(from);
  const throughTs = parseIso(through);
  // Walk the phase forward (or back) to the first occurrence on/after `from`
  // without looping over the whole gap.
  const stepsAway = Math.ceil((fromTs - anchorTs) / step);
  let ts = anchorTs + Math.max(0, stepsAway) * step;
  if (stepsAway < 0) ts = anchorTs;
  for (let i = 0; i < 1200 && ts <= throughTs; i++, ts += step) {
    if (ts >= fromTs) out.push(formatIso(ts));
  }
  return out;
}

export type PaycheckPlanEntry =
  | { action: "add"; payDate: string; amountCents: number }
  | {
      action: "update";
      id: string;
      payDate: string;
      amountCents: number;
      fromAmountCents: number;
    }
  | { action: "move"; id: string; payDate: string; fromPayDate: string; amountCents: number }
  | { action: "remove"; id: string; payDate: string; amountCents: number };

export type PaycheckPlan = {
  entries: PaycheckPlanEntry[];
  /** Rows the plan refuses to touch because they are received or in the past. */
  protectedCount: number;
};

/**
 * Diff a desired run against the rows that exist, producing the smallest set of
 * changes that gets there.
 *
 * Only rows passing `isSchedulable` are candidates. Everything else is counted
 * into `protectedCount` and left exactly as it is — including its date, so a
 * paycheck that posted early and was reconciled keeps its own record.
 *
 * `pruneExtra` controls what happens to schedulable rows the new run doesn't
 * account for: false (default) leaves them alone, true removes them. Off by
 * default because deleting a row the user added by hand is a surprise; the UI
 * turns it on for "replace this schedule".
 */
export function planSchedule(opts: {
  existing: readonly PaycheckRow[];
  label: string;
  anchor: string;
  cadence: PaycheckCadence;
  amountCents: number;
  from: string;
  through: string;
  today: string;
  pruneExtra?: boolean;
}): PaycheckPlan {
  const { existing, label, amountCents, today, pruneExtra = false } = opts;
  const inSequence = existing.filter((p) => p.isActive && sequenceLabel(p.note) === label);
  const schedulable = inSequence.filter((p) => isSchedulable(p, today));
  const protectedCount = inSequence.length - schedulable.length;

  const wanted = generateDates({
    anchor: opts.anchor,
    cadence: opts.cadence,
    from: opts.from,
    through: opts.through,
  });
  // A date already covered by a protected row is already handled — don't add a
  // duplicate alongside a paycheck that was received a day early.
  const protectedDates = new Set(
    inSequence.filter((p) => !isSchedulable(p, today)).map((p) => p.payDate),
  );

  const byDate = new Map<string, PaycheckRow>();
  for (const p of schedulable) if (!byDate.has(p.payDate)) byDate.set(p.payDate, p);

  const entries: PaycheckPlanEntry[] = [];
  const claimed = new Set<string>();

  for (const date of wanted) {
    if (protectedDates.has(date)) continue;
    const hit = byDate.get(date);
    if (hit) {
      claimed.add(hit.id);
      if (hit.amountCents !== amountCents) {
        entries.push({
          action: "update",
          id: hit.id,
          payDate: date,
          amountCents,
          fromAmountCents: hit.amountCents,
        });
      }
      continue;
    }
    entries.push({ action: "add", payDate: date, amountCents });
  }

  // Rows in the window the run didn't want. Re-space rather than churn where we
  // can: an unclaimed row pairs with an unmatched wanted date as a MOVE, which
  // is what a one-day cadence nudge actually is — and it keeps the row's id, so
  // anything referencing it survives.
  const leftovers = schedulable
    .filter((p) => !claimed.has(p.id))
    .sort((a, b) => a.payDate.localeCompare(b.payDate));
  const adds = entries.filter((e) => e.action === "add") as Extract<
    PaycheckPlanEntry,
    { action: "add" }
  >[];
  const pairs = Math.min(leftovers.length, adds.length);
  for (let i = 0; i < pairs; i++) {
    const row = leftovers[i]!;
    const add = adds[i]!;
    entries.splice(entries.indexOf(add), 1);
    entries.push({
      action: "move",
      id: row.id,
      payDate: add.payDate,
      fromPayDate: row.payDate,
      amountCents,
    });
  }
  if (pruneExtra) {
    for (const row of leftovers.slice(pairs)) {
      entries.push({
        action: "remove",
        id: row.id,
        payDate: row.payDate,
        amountCents: row.amountCents,
      });
    }
  }

  entries.sort((a, b) => a.payDate.localeCompare(b.payDate));
  return { entries, protectedCount };
}

/**
 * Group rows into sequences for the summary the page shows. Sorted by next
 * payday so the income arriving soonest reads first.
 */
export function summarizeSequences(
  paychecks: readonly PaycheckRow[],
  today: string,
): PaycheckSequence[] {
  const byLabel = new Map<string, PaycheckRow[]>();
  for (const p of paychecks) {
    if (!p.isActive) continue;
    const label = sequenceLabel(p.note);
    const list = byLabel.get(label) ?? [];
    list.push(p);
    byLabel.set(label, list);
  }

  const out: PaycheckSequence[] = [];
  for (const [label, rows] of byLabel) {
    const sorted = [...rows].sort((a, b) => a.payDate.localeCompare(b.payDate));
    const upcoming = sorted.filter((p) => isSchedulable(p, today));
    // Read the cadence off upcoming rows when there are enough of them; fall
    // back to the whole run so a sequence that has just started still reads.
    const cadence =
      inferCadence(upcoming.map((p) => p.payDate)) ??
      inferCadence(sorted.map((p) => p.payDate));
    const amountCents =
      mode(upcoming.map((p) => p.amountCents)) ?? mode(sorted.map((p) => p.amountCents)) ?? 0;
    out.push({
      label,
      cadence,
      amountCents,
      upcomingCount: upcoming.length,
      settledCount: sorted.length - upcoming.length,
      nextPayDate: upcoming[0]?.payDate ?? null,
      lastPayDate: sorted[sorted.length - 1]?.payDate ?? null,
    });
  }
  return out.sort(
    (a, b) => (a.nextPayDate ?? "9999").localeCompare(b.nextPayDate ?? "9999") ||
      a.label.localeCompare(b.label),
  );
}
