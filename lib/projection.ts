/**
 * Pure projection engine. No I/O.
 *
 * All dates are ISO "YYYY-MM-DD" strings interpreted as calendar days
 * (no timezone). All arithmetic is done in UTC milliseconds so DST
 * transitions in display timezones cannot shift day boundaries.
 *
 * All money is integer cents. No floating point is used.
 *
 * Event ordering on the same date: paycheck (credit) -> bill -> extra (debit).
 * The balance is mathematically order-independent for addition, but event
 * ordering is visible in the `events` array, and the spec requires
 * paychecks to be applied first.
 */

export type Paycheck = {
  payDate: string;
  amountCents: number;
  note?: string | null;
};

export type Bill = {
  id: string;
  name: string;
  amountCents: number;
  frequency: "monthly" | "annual";
  dueDay: number;
  dueMonth?: number | null;
};

export type OneTimeExpense = {
  date: string;
  description: string;
  amountCents: number;
};

export type ProjectionEventKind = "paycheck" | "bill" | "extra";

export type ProjectionEvent = {
  kind: ProjectionEventKind;
  label: string;
  amountCents: number;
};

export type ProjectionRow = {
  date: string;
  incomeCents: number;
  expenseCents: number;
  balanceCents: number;
  events: ProjectionEvent[];
};

export type ProjectionInput = {
  startingBalanceCents: number;
  startDate: string;
  endDate: string;
  paychecks: Paycheck[];
  bills: Bill[];
  extras: OneTimeExpense[];
};

const DAY_MS = 86_400_000;
const EVENT_ORDER: Record<ProjectionEventKind, number> = {
  paycheck: 0,
  bill: 1,
  extra: 2,
};

function parseIsoDate(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`invalid ISO date: ${s}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) {
    throw new Error(`invalid ISO date: ${s}`);
  }
  return Date.UTC(y, mo - 1, d);
}

function formatIsoDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/** Days in the given 1-indexed month of `year` (handles leap years). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Build an ISO date for (year, month, dueDay), clamping dueDay to the
 * last day of the month. Month is 1-indexed.
 */
function clampedBillDate(year: number, month: number, dueDay: number): string {
  const d = Math.min(Math.max(1, dueDay), daysInMonth(year, month));
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function computeProjection(input: ProjectionInput): ProjectionRow[] {
  const startTs = parseIsoDate(input.startDate);
  const endTs = parseIsoDate(input.endDate);
  if (endTs < startTs) return [];

  const byDate = new Map<string, ProjectionEvent[]>();

  const addEvent = (date: string, ev: ProjectionEvent) => {
    const ts = parseIsoDate(date);
    if (ts < startTs || ts > endTs) return;
    const existing = byDate.get(date);
    if (existing) existing.push(ev);
    else byDate.set(date, [ev]);
  };

  for (const p of input.paychecks) {
    const label = p.note?.trim() ? p.note.trim() : "Paycheck";
    addEvent(p.payDate, { kind: "paycheck", label, amountCents: p.amountCents });
  }

  for (const e of input.extras) {
    addEvent(e.date, { kind: "extra", label: e.description, amountCents: e.amountCents });
  }

  const startDateObj = new Date(startTs);
  const endDateObj = new Date(endTs);
  const startY = startDateObj.getUTCFullYear();
  const startM = startDateObj.getUTCMonth() + 1;
  const endY = endDateObj.getUTCFullYear();
  const endM = endDateObj.getUTCMonth() + 1;

  for (const b of input.bills) {
    if (b.frequency === "monthly") {
      for (let y = startY; y <= endY; y++) {
        const fromM = y === startY ? startM : 1;
        const toM = y === endY ? endM : 12;
        for (let m = fromM; m <= toM; m++) {
          addEvent(clampedBillDate(y, m, b.dueDay), {
            kind: "bill",
            label: b.name,
            amountCents: b.amountCents,
          });
        }
      }
    } else {
      const dueMonth = b.dueMonth;
      if (dueMonth == null) continue;
      for (let y = startY; y <= endY; y++) {
        addEvent(clampedBillDate(y, dueMonth, b.dueDay), {
          kind: "bill",
          label: b.name,
          amountCents: b.amountCents,
        });
      }
    }
  }

  for (const list of byDate.values()) {
    list.sort((a, b) => EVENT_ORDER[a.kind] - EVENT_ORDER[b.kind]);
  }

  const rows: ProjectionRow[] = [];
  let balance = input.startingBalanceCents;

  for (let ts = startTs; ts <= endTs; ts += DAY_MS) {
    const date = formatIsoDate(ts);
    const events = byDate.get(date) ?? [];
    let income = 0;
    let expense = 0;
    for (const ev of events) {
      if (ev.kind === "paycheck") income += ev.amountCents;
      else expense += ev.amountCents;
    }
    balance += income - expense;
    rows.push({
      date,
      incomeCents: income,
      expenseCents: expense,
      balanceCents: balance,
      events,
    });
  }

  return rows;
}

/**
 * Compose a friendly per-day description from a row's events, e.g.
 * "Rent + Internet" or "Paycheck + Concert tickets".
 */
export function describeEvents(events: readonly ProjectionEvent[]): string {
  if (events.length === 0) return "";
  return events.map((e) => e.label).join(" + ");
}

/** The worst (lowest balance) row, or null if input is empty. */
export function findWorstDay(rows: readonly ProjectionRow[]): ProjectionRow | null {
  if (rows.length === 0) return null;
  let worst = rows[0]!;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.balanceCents < worst.balanceCents) worst = r;
  }
  return worst;
}

/**
 * Generate biweekly-ish paycheck dates starting at `firstPayday`
 * for a given number of months past the start. Amounts use
 * `defaultAmountCents`. Useful for seeding the paychecks table.
 */
export function generatePaychecksFromSettings(opts: {
  firstPayday: string;
  frequencyDays: number;
  months: number;
  defaultAmountCents: number;
}): Paycheck[] {
  const out: Paycheck[] = [];
  const start = parseIsoDate(opts.firstPayday);
  const end = start + opts.months * 31 * DAY_MS;
  for (let ts = start; ts <= end; ts += opts.frequencyDays * DAY_MS) {
    out.push({ payDate: formatIsoDate(ts), amountCents: opts.defaultAmountCents });
  }
  return out;
}

export const __test__ = { parseIsoDate, formatIsoDate, daysInMonth, clampedBillDate };
