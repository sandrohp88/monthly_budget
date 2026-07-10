import { addDaysIso } from "@/lib/dates";
import { computeProjection } from "@/lib/projection";
import type {
  BillRow,
  CreditCardPromoPaymentRow,
  CreditCardPromoRow,
  CreditCardRow,
  CreditCardStatementRow,
  OneTimeExpenseRow,
} from "@/lib/db/schema";

/** Clamp a day-of-month to the actual number of days in that month (UTC). */
function clampDay(year: number, month: number, day: number): number {
  // month is 1..12 here
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.min(day, lastDay);
}

function isoOf(year: number, month: number, day: number): string {
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

/**
 * Next occurrence of `dayOfMonth` strictly on/after `fromIso`. Months with
 * fewer days clamp (e.g. dueDay=31 in February → Feb 28/29).
 */
export function nextDayOfMonthOnOrAfter(fromIso: string, dayOfMonth: number): string {
  const [yStr, mStr, dStr] = fromIso.split("-");
  let year = Number(yStr);
  let month = Number(mStr);
  const fromDay = Number(dStr);
  const candidate = clampDay(year, month, dayOfMonth);
  if (candidate >= fromDay) return isoOf(year, month, candidate);
  // Roll to next month
  month += 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }
  return isoOf(year, month, clampDay(year, month, dayOfMonth));
}

type StatementCycleConfig = {
  statementDay: number;
  statementCycleMode?: "calendar_day" | "interval_days" | string | null;
  statementCycleAnchorDate?: string | null;
  statementCycleIntervalDays?: number | null;
};

function isIsoDate(s: string | null | undefined): s is string {
  return /^\d{4}-\d{2}-\d{2}$/.test(s ?? "");
}

function usesIntervalStatementCycle(card: StatementCycleConfig): boolean {
  return (
    card.statementCycleMode === "interval_days" &&
    isIsoDate(card.statementCycleAnchorDate) &&
    typeof card.statementCycleIntervalDays === "number" &&
    card.statementCycleIntervalDays > 0
  );
}

function intervalStatementCycle(
  card: StatementCycleConfig,
): { anchor: string; interval: number } | null {
  if (!usesIntervalStatementCycle(card)) return null;
  return {
    anchor: card.statementCycleAnchorDate!,
    interval: card.statementCycleIntervalDays!,
  };
}

/**
 * Next statement close on/after `fromIso`.
 * Calendar-day cards use the persisted statement day. Interval cards walk from
 * an anchor statement date by `statementCycleIntervalDays` calendar days.
 */
export function nextStatementDateOnOrAfter(
  fromIso: string,
  card: StatementCycleConfig,
): string {
  const cycle = intervalStatementCycle(card);
  if (!cycle) {
    return nextDayOfMonthOnOrAfter(fromIso, card.statementDay);
  }

  const { anchor, interval } = cycle;
  if (anchor >= fromIso) return anchor;

  const elapsed = daysBetween(anchor, fromIso);
  const cycles = Math.ceil(elapsed / interval);
  return addDaysIso(anchor, cycles * interval);
}

/** Previous statement close on/before `fromIso`. */
export function previousStatementDateOnOrBefore(
  fromIso: string,
  card: StatementCycleConfig,
): string {
  const cycle = intervalStatementCycle(card);
  if (!cycle) {
    const next = nextDayOfMonthOnOrAfter(fromIso, card.statementDay);
    if (next === fromIso) return next;

    const [yStr, mStr] = next.split("-");
    let year = Number(yStr);
    let month = Number(mStr) - 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
    return isoOf(year, month, clampDay(year, month, card.statementDay));
  }

  const { anchor, interval } = cycle;
  if (anchor > fromIso) {
    const elapsed = daysBetween(fromIso, anchor);
    const cyclesBack = Math.ceil(elapsed / interval);
    return addDaysIso(anchor, -cyclesBack * interval);
  }
  const elapsed = daysBetween(anchor, fromIso);
  const cycles = Math.floor(elapsed / interval);
  return addDaysIso(anchor, cycles * interval);
}

/**
 * Given a statement date and the card's dueDay, compute the matching due date
 * for that statement. Heuristic: due date is the next occurrence of `dueDay`
 * at least `graceDays` after the statement (most US issuers grant 21–25;
 * per-card via `credit_cards.grace_period_days`, default 14).
 */
export function dueDateFromStatement(
  statementIso: string,
  dueDay: number,
  graceDays = 14,
): string {
  const earliest = addDaysIso(statementIso, Math.max(0, graceDays));
  return nextDayOfMonthOnOrAfter(earliest, dueDay);
}

/** A statement is open only when cash is actually due and no payment is recorded. */
export function isStatementOpen(s: CreditCardStatementRow): boolean {
  return statementCashDueCents(s) > 0 && s.paidAmountCents == null;
}

/**
 * Cash the statement should project on its due date.
 *
 * Normal credit-card statements use the full statement balance because the app
 * models "pay enough to avoid interest." PayPal special-financing liabilities
 * can report a $0 statement balance while still returning a required minimum
 * payment, so that minimum becomes the cash due for that cycle.
 */
export function statementCashDueCents(s: CreditCardStatementRow): number {
  return s.statementBalanceCents > 0 ? s.statementBalanceCents : (s.minimumPaymentCents ?? 0);
}

/** Did the user pay the full statement on or before the due date? */
export function paidWithoutInterest(s: CreditCardStatementRow): boolean {
  if (statementCashDueCents(s) <= 0) return true;
  if (s.paidAmountCents == null || s.paidDate == null) return false;
  return s.paidAmountCents >= statementCashDueCents(s) && s.paidDate <= s.dueDate;
}

/** Sum of unpaid balances across a list of statements. */
export function totalDue(statements: ReadonlyArray<CreditCardStatementRow>): number {
  return statements
    .filter(isStatementOpen)
    .reduce((sum, s) => sum + statementCashDueCents(s), 0);
}

/**
 * Pick the most relevant statement to surface on the card UI:
 *   1. Earliest unpaid (so user sees what's due soonest)
 *   2. Otherwise, most recent paid (so they see history)
 */
export function currentStatementOf(
  statements: ReadonlyArray<CreditCardStatementRow>,
): CreditCardStatementRow | undefined {
  const unpaid = statements.filter(isStatementOpen);
  if (unpaid.length > 0) {
    return [...unpaid].sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  }
  if (statements.length === 0) return undefined;
  return [...statements].sort((a, b) => b.statementDate.localeCompare(a.statementDate))[0];
}

/**
 * Most recent statement whose close date is on/before `asOfIso`. Statements
 * are not assumed to be pre-sorted.
 */
export function lastClosedStatement(
  statements: ReadonlyArray<CreditCardStatementRow>,
  asOfIso: string,
): CreditCardStatementRow | undefined {
  let best: CreditCardStatementRow | undefined;
  for (const s of statements) {
    if (s.statementDate > asOfIso) continue;
    if (!best || s.statementDate > best.statementDate) best = s;
  }
  return best;
}

/** ISO date `months` calendar months before `iso`, day clamped to month length. */
function subtractMonthsIso(iso: string, months: number): string {
  const [yStr, mStr, dStr] = iso.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const targetMonthIdx = m - 1 - months; // 0-based, may be negative
  const targetYear = y + Math.floor(targetMonthIdx / 12);
  const targetMonth = ((targetMonthIdx % 12) + 12) % 12; // 0..11
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Summary of statement balances over recent windows, anchored at `asOfIso`.
 * Each average is over statements whose close date falls in (asOfIso - N months, asOfIso].
 * `count` reflects how many statements contributed; the average is `null` when
 * no statements fall in the window.
 */
export type StatementBalanceSummary = {
  lastClosedCents: number | null;
  lastClosedDate: string | null;
  avg3MoCents: number | null;
  avg3MoCount: number;
  avg6MoCents: number | null;
  avg6MoCount: number;
  avg12MoCents: number | null;
  avg12MoCount: number;
};

export function summarizeStatementBalances(
  statements: ReadonlyArray<CreditCardStatementRow>,
  asOfIso: string,
): StatementBalanceSummary {
  const closed = statements.filter((s) => s.statementDate <= asOfIso);
  const last = lastClosedStatement(closed, asOfIso);

  const avgWithin = (months: number): { avg: number | null; count: number } => {
    const cutoff = subtractMonthsIso(asOfIso, months);
    const inWindow = closed.filter((s) => s.statementDate > cutoff);
    if (inWindow.length === 0) return { avg: null, count: 0 };
    const sum = inWindow.reduce((acc, s) => acc + s.statementBalanceCents, 0);
    return { avg: Math.round(sum / inWindow.length), count: inWindow.length };
  };

  const m3 = avgWithin(3);
  const m6 = avgWithin(6);
  const m12 = avgWithin(12);

  return {
    lastClosedCents: last?.statementBalanceCents ?? null,
    lastClosedDate: last?.statementDate ?? null,
    avg3MoCents: m3.avg,
    avg3MoCount: m3.count,
    avg6MoCents: m6.avg,
    avg6MoCount: m6.count,
    avg12MoCents: m12.avg,
    avg12MoCount: m12.count,
  };
}

/** Number of days between two ISO dates (UTC, may be negative). */
export function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.round((db - da) / (1000 * 60 * 60 * 24));
}

export type CardWithStatements = {
  card: CreditCardRow;
  statements: CreditCardStatementRow[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Next-cycle estimate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The card's open billing cycle is the window between the previous statement
 * close and the next one. Charges that land in this window appear on the next
 * statement. Returned dates are inclusive on both ends.
 */
export function currentCycleWindow(
  card: StatementCycleConfig,
  fromIso: string,
): { start: string; end: string } {
  const end = nextStatementDateOnOrAfter(fromIso, card);
  const prevClose = usesIntervalStatementCycle(card)
    ? addDaysIso(end, -card.statementCycleIntervalDays!)
    : previousStatementDateOnOrBefore(addDaysIso(end, -1), card);
  return { start: addDaysIso(prevClose, 1), end };
}

export type LinkedBillEstimate = {
  billId: string;
  sourceId: string;
  sourceType: "bill" | "extra" | "variable_bill";
  name: string;
  date: string;       // when it lands in this cycle
  amountCents: number;
};

/**
 * Compute every charge expected to hit the card in its current open cycle by
 * running the linked bills through the existing projection engine. Reusing
 * computeProjection means leap-year, day-clamp, and month-roll behavior stay
 * consistent with the daily ledger.
 */
export function estimateCurrentCycle(
  card: StatementCycleConfig & { dueDay: number; gracePeriodDays?: number },
  linkedBills: ReadonlyArray<BillRow>,
  fromIso: string,
  linkedExtras: ReadonlyArray<OneTimeExpenseRow> = [],
): { window: { start: string; end: string }; charges: LinkedBillEstimate[]; totalCents: number } {
  const window = currentCycleWindow(card, fromIso);
  if (linkedBills.length === 0 && linkedExtras.length === 0) {
    return { window, charges: [], totalCents: 0 };
  }

  const charges: LinkedBillEstimate[] = linkedExtras
    .filter((e) => e.date >= window.start && e.date <= window.end)
    .map((e) => ({
      sourceId: e.id,
      billId: e.id,
      sourceType: "extra" as const,
      name: e.description,
      date: e.date,
      amountCents: e.amountCents,
    }));

  const rows = computeProjection({
    startingBalanceCents: 0,
    startDate: window.start,
    endDate: window.end,
    bills: linkedBills.map((b) => ({
      id: b.id,
      name: b.name,
      amountCents: b.amountCents,
      intervalMonths: b.intervalMonths,
      anchorDate: b.anchorDate,
    })),
    paychecks: [],
    extras: [],
  });

  for (const row of rows) {
    for (const ev of row.events) {
      // Bill events carry the source bill's id — name matching would
      // mis-attribute charges when two bills share a display label.
      if (ev.kind !== "bill" || !ev.sourceId) continue;
      charges.push({
        sourceId: ev.sourceId,
        billId: ev.sourceId,
        sourceType: "bill",
        name: ev.label,
        date: row.date,
        amountCents: ev.amountCents,
      });
    }
  }
  const totalCents = charges.reduce((s, c) => s + c.amountCents, 0);
  return { window, charges, totalCents };
}

// ─────────────────────────────────────────────────────────────────────────────
// Promotional financing (0% APR for X months)
// ─────────────────────────────────────────────────────────────────────────────

/** Whole-month count from `from` to `to` (inclusive of both endpoints' months). */
function monthsBetweenInclusive(fromIso: string, toIso: string): number {
  const [fy, fm] = fromIso.split("-").map(Number);
  const [ty, tm] = toIso.split("-").map(Number);
  const months = (ty! - fy!) * 12 + (tm! - fm!) + 1;
  return Math.max(1, months);
}

/**
 * The cash chunk a promo demands at a given as-of date. Used both by the
 * projection (to inject monthly debits for future cycles) and by the
 * statement-payment auto-decrement (to know how much to subtract from
 * `remainingAmountCents`).
 *
 * Rules:
 *   - explicit `monthlyPaymentCents` override wins, clamped to remaining
 *   - otherwise: ceil(remaining / months_left_inclusive)
 *   - if as-of is past `endDate`, return the full remaining (last-chance lump
 *     so the projection visualises the "must clear by deadline" pressure)
 */
export function promoMonthlyChunkAt(
  promo: Pick<
    CreditCardPromoRow,
    "remainingAmountCents" | "monthlyPaymentCents" | "endDate"
  >,
  asOfIso: string,
): number {
  if (promo.remainingAmountCents <= 0) return 0;
  if (asOfIso > promo.endDate) return promo.remainingAmountCents;
  if (promo.monthlyPaymentCents != null) {
    return Math.min(promo.monthlyPaymentCents, promo.remainingAmountCents);
  }
  const months = monthsBetweenInclusive(asOfIso, promo.endDate);
  return Math.min(
    promo.remainingAmountCents,
    Math.ceil(promo.remainingAmountCents / months),
  );
}

export type PromoCycleSchedule = {
  /** Due date the chunk lands on (the card's dueDay clamped). */
  dueDate: string;
  amountCents: number;
};

export type PromoCycleScheduleWithBalance = PromoCycleSchedule & {
  /** Promo principal remaining immediately before this cycle's payment. */
  balanceBeforeCents: number;
};

/**
 * Project a promo's payment schedule. Two modes:
 *
 *   1. **Manual schedule** — when `scheduledPayments` is non-empty, use those
 *      verbatim (filtered to `>= fromIso` and not in `skipDueDates`). The user
 *      has opted into custom control: no auto-spread, no convergence math,
 *      no end-date lump. This is purely a projection input — if the schedule
 *      doesn't sum to `remainingAmountCents`, the UI surfaces the gap but
 *      the projection just uses what the user wrote.
 *
 *   2. **Auto-spread** (default) — chunks land on each future cycle's due
 *      date through the promo's `endDate`. Iterates one chunk at a time,
 *      decrementing a virtual remaining balance and recomputing the per-cycle
 *      chunk so the schedule converges to zero by the deadline.
 *
 * `skipDueDates` skips cycles already covered by a recorded statement (those
 * cycles are authoritative for any promo cash they include).
 */
export function projectPromoSchedule(
  promo: CreditCardPromoRow,
  card: StatementCycleConfig & { dueDay: number; gracePeriodDays?: number },
  fromIso: string,
  skipDueDates: ReadonlySet<string>,
  scheduledPayments: ReadonlyArray<Pick<CreditCardPromoPaymentRow, "dueDate" | "amountCents">> = [],
): PromoCycleSchedule[] {
  return projectPromoScheduleWithBalances(
    promo,
    card,
    fromIso,
    skipDueDates,
    scheduledPayments,
  ).map(({ dueDate, amountCents }) => ({ dueDate, amountCents }));
}

export function projectPromoScheduleWithBalances(
  promo: CreditCardPromoRow,
  card: StatementCycleConfig & { dueDay: number; gracePeriodDays?: number },
  fromIso: string,
  skipDueDates: ReadonlySet<string>,
  scheduledPayments: ReadonlyArray<Pick<CreditCardPromoPaymentRow, "dueDate" | "amountCents">> = [],
): PromoCycleScheduleWithBalance[] {
  if (scheduledPayments.length > 0) {
    if (!promo.isActive) return [];
    let virtualRemaining = promo.remainingAmountCents;
    const out: PromoCycleScheduleWithBalance[] = [];
    const payments = scheduledPayments
      .filter((p) => p.amountCents > 0 && p.dueDate >= fromIso)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    for (const payment of payments) {
      if (!skipDueDates.has(payment.dueDate)) {
        out.push({
          dueDate: payment.dueDate,
          amountCents: payment.amountCents,
          balanceBeforeCents: virtualRemaining,
        });
      }
      virtualRemaining = Math.max(0, virtualRemaining - payment.amountCents);
    }
    return out;
  }
  if (promo.remainingAmountCents <= 0) return [];
  if (!promo.isActive) return [];

  const out: PromoCycleScheduleWithBalance[] = [];
  const scheduleChunk = (dueDate: string, asOfIso: string): void => {
    const balanceBeforeCents = virtualRemaining;
    const chunk = promoMonthlyChunkAt(
      {
        remainingAmountCents: virtualRemaining,
        monthlyPaymentCents: promo.monthlyPaymentCents,
        endDate: promo.endDate,
      },
      asOfIso,
    );
    if (chunk > 0 && !skipDueDates.has(dueDate)) {
      out.push({ dueDate, amountCents: chunk, balanceBeforeCents });
    }
    virtualRemaining -= chunk;
  };
  // Walk forward one cycle at a time. The "cycle" pointer is a date inside the
  // billing window; nextDayOfMonthOnOrAfter gives us its statement close, then
  // dueDateFromStatement turns that into the payment due date.
  let cursor = fromIso;
  let virtualRemaining = promo.remainingAmountCents;
  const firstStatement = nextStatementDateOnOrAfter(cursor, card);
  const firstStatementDueDate = dueDateFromStatement(firstStatement, card.dueDay, card.gracePeriodDays);
  const activeFrom = fromIso > promo.startDate ? fromIso : promo.startDate;
  const currentCycleDueDate = nextDayOfMonthOnOrAfter(activeFrom, card.dueDay);
  const currentPaymentDate =
    currentCycleDueDate > promo.endDate ? promo.endDate : currentCycleDueDate;
  if (
    currentPaymentDate >= fromIso &&
    currentPaymentDate < firstStatementDueDate &&
    virtualRemaining > 0
  ) {
    scheduleChunk(currentPaymentDate, currentPaymentDate);
  }
  // Hard cap on iterations to avoid runaway loops if dates ever go sideways.
  for (let i = 0; i < 240 && virtualRemaining > 0; i++) {
    const statement = nextStatementDateOnOrAfter(cursor, card);
    const dueDate = dueDateFromStatement(statement, card.dueDay, card.gracePeriodDays);
    // Stop scheduling once we'd be paying after the deadline. The final chunk
    // (forced "lump") is captured below by the asOfIso > endDate branch.
    if (dueDate > promo.endDate) {
      // Past the deadline. Force any remaining principal to land on the
      // promo's endDate itself — never on a later due date — so the cliff
      // visualizes ON the deadline. The user sees the lump as the
      // last-chance payment, which matches how issuers actually charge
      // deferred interest if the promo isn't paid off in time.
      const chunk = virtualRemaining;
      const cliffDate = promo.endDate;
      if (!skipDueDates.has(cliffDate)) {
        out.push({ dueDate: cliffDate, amountCents: chunk, balanceBeforeCents: virtualRemaining });
      }
      virtualRemaining = 0;
      break;
    }
    scheduleChunk(dueDate, statement);
    // Advance cursor past this cycle to find the next one
    cursor = addDaysIso(statement, 1);
  }
  return out;
}

export type PromoWhatIf = {
  /** Pay everything off today: cash out NOW, no future projected chunks. */
  payOffNow: { totalCents: number; cashOutDate: string };
  /** Continue monthly schedule: cash out spread across cycles until end date. */
  continueSchedule: {
    totalCents: number;
    chunks: PromoCycleSchedule[];
    finalDueDate: string | null;
  };
};

/**
 * Build a side-by-side comparison of "pay this promo off today" vs. "continue
 * the monthly schedule". Pure math — no recommendation.
 */
export function promoWhatIf(
  promo: CreditCardPromoRow,
  card: StatementCycleConfig & { dueDay: number; gracePeriodDays?: number },
  todayIso: string,
  scheduledPayments: ReadonlyArray<Pick<CreditCardPromoPaymentRow, "dueDate" | "amountCents">> = [],
): PromoWhatIf {
  const chunks = projectPromoSchedule(promo, card, todayIso, new Set(), scheduledPayments);
  const totalScheduled = chunks.reduce((s, c) => s + c.amountCents, 0);
  return {
    payOffNow: {
      totalCents: promo.remainingAmountCents,
      cashOutDate: todayIso,
    },
    continueSchedule: {
      totalCents: totalScheduled,
      chunks,
      finalDueDate: chunks.length > 0 ? chunks[chunks.length - 1]!.dueDate : null,
    },
  };
}

/**
 * Card-level rollup: combine all active promos on a card into a single
 * "pay everything off today" vs. "continue all schedules" comparison.
 */
export function cardPromoWhatIf(
  promos: ReadonlyArray<CreditCardPromoRow>,
  card: StatementCycleConfig & { dueDay: number; gracePeriodDays?: number },
  todayIso: string,
  paymentsByPromoId: ReadonlyMap<string, ReadonlyArray<Pick<CreditCardPromoPaymentRow, "dueDate" | "amountCents">>> = new Map(),
): PromoWhatIf {
  const active = promos.filter((p) => p.isActive && p.remainingAmountCents > 0);
  const payOffTotal = active.reduce((s, p) => s + p.remainingAmountCents, 0);
  const allChunks: PromoCycleSchedule[] = [];
  for (const p of active) {
    const sched = paymentsByPromoId.get(p.id) ?? [];
    allChunks.push(...projectPromoSchedule(p, card, todayIso, new Set(), sched));
  }
  // Merge chunks landing on the same due date so the UI shows one entry per cycle.
  const byDate = new Map<string, number>();
  for (const c of allChunks) {
    byDate.set(c.dueDate, (byDate.get(c.dueDate) ?? 0) + c.amountCents);
  }
  const merged = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dueDate, amountCents]) => ({ dueDate, amountCents }));
  const totalScheduled = merged.reduce((s, c) => s + c.amountCents, 0);
  return {
    payOffNow: { totalCents: payOffTotal, cashOutDate: todayIso },
    continueSchedule: {
      totalCents: totalScheduled,
      chunks: merged,
      finalDueDate: merged.length > 0 ? merged[merged.length - 1]!.dueDate : null,
    },
  };
}
