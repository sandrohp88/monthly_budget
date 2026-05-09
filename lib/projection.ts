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
  /** Cycle length in months. 1=monthly, 3=quarterly, 12=annual, etc. */
  intervalMonths: number;
  /** ISO YYYY-MM-DD of one known occurrence. */
  anchorDate: string;
  /** Optional planned payment amounts for specific generated due dates. */
  paymentOverrides?: Array<{ date: string; amountCents: number }>;
  /**
   * When the starting balance comes from a live bank account, cash movements
   * before today are already reflected in that balance. Past bill occurrences
   * before this date should not change the running projection again.
   */
  settledBeforeDate?: string;
  /** Show settled past occurrences as paid rows instead of hiding them. */
  showSettledBeforeDate?: boolean;
};

export type OneTimeExpense = {
  date: string;
  description: string;
  amountCents: number;
  sourceId?: string;
  sourceType?: "creditCardPayment";
  originalAmountCents?: number;
  relatedDate?: string;
  paymentDueCents?: number;
  paymentBalanceCents?: number;
  isPaid?: boolean;
};

export type ProjectionEventKind = "paycheck" | "bill" | "extra";
export type ProjectionEventSourceType = "bill" | "creditCardPayment";

export type ProjectionEvent = {
  kind: ProjectionEventKind;
  label: string;
  amountCents: number;
  sourceId?: string;
  sourceType?: ProjectionEventSourceType;
  originalAmountCents?: number;
  relatedDate?: string;
  paymentDueCents?: number;
  paymentBalanceCents?: number;
  isPaid?: boolean;
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

/**
 * Anchor the projection's running balance.
 *
 * The starting balance is a snapshot taken at a known point in time. Walking
 * the projection forward from that point keeps the running balance aligned
 * with reality.
 *
 *   - With a Plaid-linked account → today, because the live balance is always
 *     current. Anything before today is already inside that balance.
 *   - With a manual starting balance → `startingBalanceAsOf`, the date the
 *     user actually saw that number on their bank statement.
 *
 * `firstPaydayDate` is no longer the anchor — only the recurrence anchor for
 * the paycheck schedule. Conflating the two was the source of the
 * "balance is off by a paycheck" bug.
 */
export function resolveProjectionStartDate(opts: {
  startingBalanceAsOf: string;
  today: string;
  usesLinkedStartingBalance: boolean;
}): string {
  if (opts.usesLinkedStartingBalance) return opts.today;
  return opts.startingBalanceAsOf;
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

/**
 * Add `deltaMonths` to (year, month) — month is 1-indexed — and clamp `day`
 * to the resulting month's length. Handles negative deltas correctly.
 */
function addMonthsClamped(
  year: number,
  month: number,
  day: number,
  deltaMonths: number,
): { year: number; month: number; day: number } {
  const totalMonths = year * 12 + (month - 1) + deltaMonths;
  const y = Math.floor(totalMonths / 12);
  const m = ((totalMonths % 12) + 12) % 12 + 1;
  const d = Math.min(day, daysInMonth(y, m));
  return { year: y, month: m, day: d };
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
    addEvent(e.date, {
      kind: "extra",
      label: e.description,
      amountCents: e.amountCents,
      sourceId: e.sourceId,
      sourceType: e.sourceType,
      originalAmountCents: e.originalAmountCents,
      relatedDate: e.relatedDate,
      paymentDueCents: e.paymentDueCents,
      paymentBalanceCents: e.paymentBalanceCents,
      isPaid: e.isPaid,
    });
  }

  const startDateObj = new Date(startTs);
  const endDateObj = new Date(endTs);
  const startY = startDateObj.getUTCFullYear();
  const startM = startDateObj.getUTCMonth() + 1;
  const endY = endDateObj.getUTCFullYear();
  const endM = endDateObj.getUTCMonth() + 1;

  for (const b of input.bills) {
    if (b.intervalMonths < 1) continue;
    const overrides = new Map(
      (b.paymentOverrides ?? []).map((o) => [o.date, o.amountCents] as const),
    );
    const anchorTs = parseIsoDate(b.anchorDate);
    const anchorObj = new Date(anchorTs);
    const anchorY = anchorObj.getUTCFullYear();
    const anchorM = anchorObj.getUTCMonth() + 1;
    const anchorD = anchorObj.getUTCDate();

    // Months between anchor and the projection window, used to bracket the
    // range of `k` values we need to enumerate. The ±1 buffer absorbs
    // off-by-ones from day-clamping and partial-month boundaries.
    const anchorMonths = anchorY * 12 + (anchorM - 1);
    const startMonths = startY * 12 + (startM - 1);
    const endMonths = endY * 12 + (endM - 1);
    const kStart = Math.floor((startMonths - anchorMonths) / b.intervalMonths) - 1;
    const kEnd = Math.floor((endMonths - anchorMonths) / b.intervalMonths) + 1;

    for (let k = kStart; k <= kEnd; k++) {
      const occ = addMonthsClamped(anchorY, anchorM, anchorD, k * b.intervalMonths);
      const date = `${String(occ.year).padStart(4, "0")}-${String(occ.month).padStart(2, "0")}-${String(occ.day).padStart(2, "0")}`;
      if (b.settledBeforeDate && date < b.settledBeforeDate) {
        if (!b.showSettledBeforeDate) continue;
        addEvent(date, {
          kind: "bill",
          label: b.name,
          amountCents: 0,
          sourceId: b.id,
          sourceType: "bill",
          originalAmountCents: b.amountCents,
          isPaid: true,
        });
        continue;
      }
      const override = overrides.get(date);
      addEvent(date, {
        kind: "bill",
        label: b.name,
        amountCents: override ?? b.amountCents,
        sourceId: b.id,
        sourceType: "bill",
        originalAmountCents: b.amountCents,
      });
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
      if (ev.kind === "paycheck") {
        income += ev.amountCents;
      } else if (ev.kind === "extra" && ev.amountCents < 0) {
        // Negative-amount extras are credits (Plaid refunds, returns,
        // statement credits). They add to the running balance — surface
        // them in the income column instead of as a "−-$X" expense.
        income += -ev.amountCents;
      } else {
        expense += ev.amountCents;
      }
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
