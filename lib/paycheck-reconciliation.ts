/**
 * Match incoming bank deposits (Plaid drafts) against scheduled paychecks so
 * the sync can mark a paycheck as received with its real posted amount — the
 * income-side analog of lib/bill-reconciliation.ts.
 *
 * Pure — no I/O. Wired in lib/plaid-sync.ts (reconcilePaycheckDeposits) with
 * approved deposit drafts from the accounts that feed the starting balance.
 * Unlike the bill matcher this one PERSISTS its result (actualReceived +
 * actualAmountCents on the paycheck row) via settlePaycheckWithDraft, which
 * owns the not-received→received edge and the consume-once draft gate.
 *
 * Matching is deliberately conservative: a false negative just leaves the row
 * for manual reconciliation, while a false positive silently records wrong
 * income. Amount + date proximity are the primary signals — payroll deposits
 * rarely carry a useful employer name, and two earners' deposits on the same
 * day must split by amount, not by text.
 *   - date: deposit posted within ±PAYCHECK_MATCH_WINDOW_DAYS of the
 *     scheduled payDate (payroll posts early on holidays, late on weekends).
 *   - amount: deposit magnitude within [MIN_FRACTION, MAX_FRACTION] of the
 *     planned amount. The floor tolerates hours/deduction variance; the
 *     ceiling keeps a windfall (tax refund, transfer) from posing as a
 *     paycheck.
 *   - text: a paycheck's note matching the draft's description/merchant is an
 *     optional extra signal — it only PRIORITIZES a pair during assignment,
 *     it never gates or widens eligibility.
 *   - assignment: best-amount-fit. Two scheduled paychecks never share a
 *     deposit (two earners). A scheduled paycheck plus one or more one-time
 *     incomes DO share one deposit when the posted amount is the sum — a
 *     bonus that arrived in the same credit as the paycheck. Each row then
 *     records its own share, not the whole deposit. There is no
 *     leftover-folding phase — a paycheck never posts as several partial
 *     deposits the way a utility posts split ACH pulls. An explicit split
 *     (draft_allocations of kind `paycheck`) is the user's answer when the
 *     sum isn't clear enough to guess.
 */

import { splitIsValid } from "./bill-reconciliation";
import type { PaycheckRow } from "./db/schema";
import { daysBetween } from "./dates";

export const PAYCHECK_MATCH_WINDOW_DAYS = 5;
/**
 * Deposit must reach this fraction of the planned amount to settle the
 * paycheck. Guards against a small unrelated deposit (rebate, reimbursement)
 * marking a paycheck received, while tolerating a light check — fewer hours,
 * extra deductions.
 */
export const PAYCHECK_MATCH_MIN_FRACTION = 0.7;
/**
 * Deposit must stay under this multiple of the planned amount. Overtime and
 * modest bonuses land well inside 2×; a deposit beyond it (tax refund, house
 * sale, transfer between own accounts) is not this paycheck.
 */
export const PAYCHECK_MATCH_MAX_FRACTION = 2;
/**
 * How much closer another paycheck's amount must be before this deposit is
 * treated as plainly that one's, not this one's. Used by the other-earner guard
 * below — never as an eligibility gate of its own.
 *
 * Small on purpose: real payroll varies by cents (hours, deductions), so two
 * rows that genuinely compete for one deposit differ by cents, not dollars. A
 * whole $5 of extra distance means the other row is simply the better answer.
 */
export const PAYCHECK_BETTER_FIT_CENTS = 500;

export type ReconcilableDepositDraft = {
  id: string;
  date: string; // ISO
  description: string;
  merchantName: string | null;
  /** Plaid convention: NEGATIVE = credit/money in. Only negatives can match. */
  amountCents: number;
};

export type ReconcilablePaycheck = Pick<PaycheckRow, "id" | "payDate" | "amountCents"> & {
  /** Optional text hint (the paycheck's note) — priority signal only. */
  note?: string | null;
  /**
   * One-time income (bonus) rather than a scheduled paycheck. Omitted or
   * false means scheduled. A combined deposit may settle one scheduled
   * paycheck together with one-time rows; two scheduled paychecks may not.
   */
  isOneTime?: boolean;
};

export type PaycheckDepositMatch = {
  paycheckId: string;
  draftId: string;
  /** The deposit's posting date — becomes the "received" date semantically. */
  depositDate: string;
  /**
   * Positive cents recorded as this income's actual amount. A one-to-one
   * match records the whole deposit. A combined paycheck-plus-bonus deposit
   * records each row's share, and the shares sum to the deposit.
   */
  depositAmountCents: number;
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Does the draft's text plausibly carry the paycheck's note (employer hint)?
 * Same containment rules as the bill matcher's name gate, but used only to
 * prioritize assignment — never to include or exclude a pair.
 */
export function draftMatchesPaycheckNote(
  note: string | null | undefined,
  draft: Pick<ReconcilableDepositDraft, "description" | "merchantName">,
): boolean {
  if (!note) return false;
  const hint = normalize(note);
  if (hint.length < 3) return false; // too short to trust substring matching
  const haystacks = [draft.description, draft.merchantName ?? ""].map(normalize);
  return haystacks.some((h) => h.length >= 3 && (h.includes(hint) || hint.includes(h)));
}

/** Cap subset search. A 5-day window never has this many one-time incomes. */
const MAX_ONE_TIMES_PER_DEPOSIT = 8;

function nonEmptySubsets<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  const n = items.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const subset: T[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) subset.push(items[i]!);
    out.push(subset);
  }
  return out;
}

type IncomeCombo = {
  draft: ReconcilableDepositDraft;
  paycheck: ReconcilablePaycheck;
  oneTimes: ReconcilablePaycheck[];
  gapSum: number;
  paycheckShare: number;
};

/**
 * Deposits that are a scheduled paycheck plus one or more one-time incomes
 * posted together. The one-time rows keep their planned amounts (a bonus is
 * a known figure) and the paycheck absorbs the difference, which still has
 * to land inside the paycheck's own amount band. The sum has to explain the
 * deposit materially better than any single member, and better than any
 * other scheduled paycheck in range — including one already reconciled —
 * so another earner's deposit is not retold as "paycheck plus bonus".
 */
function combinedIncomeDeposits(
  expected: readonly ReconcilablePaycheck[],
  deposits: readonly ReconcilableDepositDraft[],
  schedule: readonly ReconcilablePaycheck[],
  windowDays: number,
): IncomeCombo[] {
  const inWindow = (payDate: string, draftDate: string) =>
    Math.abs(daysBetween(payDate, draftDate)) <= windowDays;
  const combos: IncomeCombo[] = [];

  for (const draft of deposits) {
    const depositCents = -draft.amountCents;
    const near = expected.filter((p) => p.amountCents > 0 && inWindow(p.payDate, draft.date));
    const scheduled = near.filter((p) => !p.isOneTime);
    let oneTimes = near.filter((p) => p.isOneTime === true);
    if (scheduled.length === 0 || oneTimes.length === 0) continue;
    if (oneTimes.length > MAX_ONE_TIMES_PER_DEPOSIT) {
      oneTimes = [...oneTimes]
        .sort(
          (a, b) =>
            Math.abs(daysBetween(a.payDate, draft.date)) -
              Math.abs(daysBetween(b.payDate, draft.date)) || a.id.localeCompare(b.id),
        )
        .slice(0, MAX_ONE_TIMES_PER_DEPOSIT);
    }

    for (const paycheck of scheduled) {
      for (const subset of nonEmptySubsets(oneTimes)) {
        if (subset.some((o) => Math.abs(daysBetween(o.payDate, paycheck.payDate)) > windowDays)) {
          continue;
        }
        const oneTimeSum = subset.reduce((sum, o) => sum + o.amountCents, 0);
        const plannedSum = paycheck.amountCents + oneTimeSum;
        const gapSum = Math.abs(depositCents - plannedSum);
        const gapPaycheck = Math.abs(depositCents - paycheck.amountCents);
        if (gapPaycheck - gapSum <= PAYCHECK_BETTER_FIT_CENTS) continue;
        if (
          subset.some(
            (o) => Math.abs(depositCents - o.amountCents) - gapSum <= PAYCHECK_BETTER_FIT_CENTS,
          )
        ) {
          continue;
        }
        if (depositCents < Math.round(plannedSum * PAYCHECK_MATCH_MIN_FRACTION)) continue;
        if (depositCents > Math.round(plannedSum * PAYCHECK_MATCH_MAX_FRACTION)) continue;
        const paycheckShare = depositCents - oneTimeSum;
        if (paycheckShare < Math.round(paycheck.amountCents * PAYCHECK_MATCH_MIN_FRACTION)) continue;
        if (paycheckShare > Math.round(paycheck.amountCents * PAYCHECK_MATCH_MAX_FRACTION)) continue;
        const explainedByAnotherPaycheck = schedule.some((other) => {
          if (other.id === paycheck.id || other.isOneTime || other.amountCents <= 0) return false;
          if (!inWindow(other.payDate, draft.date)) return false;
          return Math.abs(depositCents - other.amountCents) <= gapSum + PAYCHECK_BETTER_FIT_CENTS;
        });
        if (explainedByAnotherPaycheck) continue;
        combos.push({ draft, paycheck, oneTimes: subset, gapSum, paycheckShare });
      }
    }
  }

  combos.sort(
    (a, b) =>
      a.gapSum - b.gapSum ||
      a.oneTimes.length - b.oneTimes.length ||
      a.paycheck.id.localeCompare(b.paycheck.id) ||
      a.oneTimes
        .map((o) => o.id)
        .join()
        .localeCompare(b.oneTimes.map((o) => o.id).join()) ||
      a.draft.id.localeCompare(b.draft.id),
  );
  return combos;
}

/**
 * Find paychecks settled by posted deposits. `paychecks` should already be
 * limited to rows awaiting reconciliation (active, not yet received);
 * `drafts` to approved rows on the accounts whose balance feeds the
 * projection. Consumed drafts (already settled some paycheck) must be
 * excluded by the caller — otherwise a spent draft can win an assignment
 * here that the persistence layer then rejects, starving a free draft.
 */
export function matchPaycheckDeposits(
  paychecks: ReadonlyArray<ReconcilablePaycheck>,
  drafts: ReadonlyArray<ReconcilableDepositDraft>,
  opts: { windowDays?: number; schedule?: ReadonlyArray<ReconcilablePaycheck> } = {},
): PaycheckDepositMatch[] {
  const windowDays = Math.max(1, opts.windowDays ?? PAYCHECK_MATCH_WINDOW_DAYS);

  const deposits = drafts.filter((d) => d.amountCents < 0);
  const expected = paychecks.filter((p) => p.amountCents > 0);
  if (deposits.length === 0 || expected.length === 0) return [];

  /**
   * Every scheduled paycheck in range, ALREADY-RECONCILED ONES INCLUDED —
   * `paychecks` holds only rows still awaiting reconciliation.
   *
   * Splitting two earners by amount only works while both their rows are on
   * the board. Once one is reconciled (auto-settled, or marked received by
   * hand) it leaves `paychecks`, and the next deposit for that earner finds
   * only the OTHER earner's row to land on. The eligibility band is wide by
   * design — a $2,000 paycheck accepts up to $4,000 so overtime still
   * matches — so a $3,974.43 payroll deposit sails under the ceiling of a
   * $2,000 row and silently records wrong income. That is exactly how a
   * biweekly $3,974 deposit ended up recorded against a monthly $2,000
   * paycheck (2026-08-30).
   */
  const schedule = opts.schedule ?? paychecks;

  type Pair = {
    paycheck: ReconcilablePaycheck;
    draft: ReconcilableDepositDraft;
    noteMatch: boolean;
    distanceDays: number;
    amountGapCents: number;
  };
  const gapTo = (depositCents: number, p: ReconcilablePaycheck) =>
    Math.abs(depositCents - p.amountCents);

  /**
   * Is this deposit plainly some OTHER scheduled paycheck's, rather than the
   * one we're about to hand it to? True when another row in range fits its
   * amount MATERIALLY better.
   *
   * This is the one direction where the note hint must not get a vote. Choosing
   * among DEPOSITS for one paycheck, a note is provenance — the employer's name
   * on the wire really does say which deposit is that paycheck. Choosing among
   * PAYCHECKS for one deposit, it says much less: a bank description names
   * whoever it likes, including the RECIPIENT. A transfer reading
   * "Co: Sandro Herrera Name: Lisette Izada Galiano" carries her name while
   * being entirely his money, so labelling her rows "Lisette" would hand his
   * $4,000 to her $3,974 paycheck — past the amount band (1.99x), past the sort
   * (noteMatch outranks amount fit), and into her income. Amount decides here.
   *
   * Deliberately asymmetric: it can only REJECT a pair, never rescue one, so the
   * conservative bias of the whole matcher is preserved — an unmatched deposit
   * waits for the user, while a wrong match silently records wrong income.
   */
  const belongsToAnotherPaycheck = (
    depositCents: number,
    draftDate: string,
    candidate: ReconcilablePaycheck,
  ) => {
    const ourGap = gapTo(depositCents, candidate);
    return schedule.some(
      (other) =>
        other.id !== candidate.id &&
        other.amountCents > 0 &&
        Math.abs(daysBetween(other.payDate, draftDate)) <= windowDays &&
        ourGap - gapTo(depositCents, other) > PAYCHECK_BETTER_FIT_CENTS,
    );
  };

  const pairs: Pair[] = [];
  for (const paycheck of expected) {
    for (const draft of deposits) {
      const distance = Math.abs(daysBetween(paycheck.payDate, draft.date));
      if (distance > windowDays) continue;
      const depositCents = -draft.amountCents;
      if (depositCents < Math.round(paycheck.amountCents * PAYCHECK_MATCH_MIN_FRACTION)) continue;
      if (depositCents > Math.round(paycheck.amountCents * PAYCHECK_MATCH_MAX_FRACTION)) continue;
      if (belongsToAnotherPaycheck(depositCents, draft.date, paycheck)) continue;
      pairs.push({
        paycheck,
        draft,
        noteMatch: draftMatchesPaycheckNote(paycheck.note, draft),
        distanceDays: distance,
        amountGapCents: Math.abs(depositCents - paycheck.amountCents),
      });
    }
  }
  // Combined paycheck + bonus deposits are assigned first, each income
  // taking its share of the one credit — including when the deposit is too
  // large for either income's own band, so no one-to-one pair exists. Two
  // scheduled paychecks still never share a draft. Then best amount fit,
  // one remaining draft per paycheck and one paycheck per draft.
  // Note-matched pairs go first so an employer hint can break a near-tie
  // among one-to-one pairs.
  const byFit = [...pairs].sort(
    (a, b) =>
      Number(b.noteMatch) - Number(a.noteMatch) ||
      a.amountGapCents - b.amountGapCents ||
      a.distanceDays - b.distanceDays ||
      a.paycheck.id.localeCompare(b.paycheck.id) ||
      a.draft.id.localeCompare(b.draft.id),
  );
  const assignedDrafts = new Set<string>();
  const assignedPaychecks = new Set<string>();
  const out: PaycheckDepositMatch[] = [];
  for (const combo of combinedIncomeDeposits(expected, deposits, schedule, windowDays)) {
    if (assignedDrafts.has(combo.draft.id) || assignedPaychecks.has(combo.paycheck.id)) continue;
    if (combo.oneTimes.some((oneTime) => assignedPaychecks.has(oneTime.id))) continue;
    assignedDrafts.add(combo.draft.id);
    assignedPaychecks.add(combo.paycheck.id);
    out.push({
      paycheckId: combo.paycheck.id,
      draftId: combo.draft.id,
      depositDate: combo.draft.date,
      depositAmountCents: combo.paycheckShare,
    });
    for (const oneTime of combo.oneTimes) {
      assignedPaychecks.add(oneTime.id);
      out.push({
        paycheckId: oneTime.id,
        draftId: combo.draft.id,
        depositDate: combo.draft.date,
        depositAmountCents: oneTime.amountCents,
      });
    }
  }
  for (const p of byFit) {
    if (assignedDrafts.has(p.draft.id) || assignedPaychecks.has(p.paycheck.id)) continue;
    assignedDrafts.add(p.draft.id);
    assignedPaychecks.add(p.paycheck.id);
    out.push({
      paycheckId: p.paycheck.id,
      draftId: p.draft.id,
      depositDate: p.draft.date,
      depositAmountCents: -p.draft.amountCents,
    });
  }
  out.sort((a, b) => a.paycheckId.localeCompare(b.paycheckId));
  return out;
}

/**
 * Settle incomes the user explicitly split a deposit across.
 *
 * Allocations are exhaustive: the caller must keep the draft out of
 * {@link matchPaycheckDeposits}. The settle floor still applies per income —
 * naming the paycheck decides where the money went, and a token portion does
 * not mark a large paycheck received. There is no amount ceiling: the user
 * already said this portion is that income.
 */
export function matchAllocatedIncome(
  paychecks: ReadonlyArray<ReconcilablePaycheck>,
  drafts: ReadonlyArray<
    ReconcilableDepositDraft & {
      allocations?: ReadonlyArray<{
        targetKind: string;
        targetId: string;
        targetDate: string;
        amountCents: number;
      }>;
    }
  >,
): PaycheckDepositMatch[] {
  const byId = new Map(paychecks.map((p) => [p.id, p]));
  const used = new Set<string>();
  const out: PaycheckDepositMatch[] = [];
  for (const draft of drafts) {
    const allocations = draft.allocations ?? [];
    if (allocations.length === 0) continue;
    if (!splitIsValid({ amountCents: draft.amountCents, allocations })) continue;
    if (draft.amountCents >= 0) continue;
    for (const allocation of allocations) {
      if (allocation.targetKind !== "paycheck" || allocation.amountCents <= 0) continue;
      const paycheck = byId.get(allocation.targetId);
      if (!paycheck || paycheck.amountCents <= 0 || paycheck.payDate !== allocation.targetDate) continue;
      if (used.has(paycheck.id)) continue;
      const floor = Math.round(paycheck.amountCents * PAYCHECK_MATCH_MIN_FRACTION);
      if (allocation.amountCents < floor) continue;
      used.add(paycheck.id);
      out.push({
        paycheckId: paycheck.id,
        draftId: draft.id,
        depositDate: draft.date,
        depositAmountCents: allocation.amountCents,
      });
    }
  }
  out.sort((a, b) => a.paycheckId.localeCompare(b.paycheckId));
  return out;
}
