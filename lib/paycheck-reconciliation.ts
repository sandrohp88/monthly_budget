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
 *   - assignment: single phase, best-amount-fit, one draft per paycheck and
 *     one paycheck per draft (the bill matcher's phase 1). There is no
 *     leftover-folding phase 2 — a paycheck never posts as several partial
 *     deposits the way a utility posts split ACH pulls.
 */

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
};

export type PaycheckDepositMatch = {
  paycheckId: string;
  draftId: string;
  /** The deposit's posting date — becomes the "received" date semantically. */
  depositDate: string;
  /** Positive magnitude of the deposit — becomes actualAmountCents. */
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
  if (pairs.length === 0) return [];

  // Best amount fit, ONE draft per paycheck and ONE paycheck per draft. Two
  // same-day paychecks (two earners) each take the deposit closest to their
  // planned amount instead of both being handed the first deposit seen.
  // Note-matched pairs go first so an employer hint can break a near-tie.
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
