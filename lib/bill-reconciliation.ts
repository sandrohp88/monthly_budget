/**
 * Match posted bank transactions against generated bill occurrences so the
 * projection can mark an occurrence as already paid instead of projecting it
 * as a pending debit (which would double-count in linked-balance mode: the
 * live balance already reflects the payment).
 *
 * Pure — no I/O. Wired in lib/projection-server.ts (linked mode only) with
 * approved drafts from the accounts that feed the starting balance.
 *
 * Matching is deliberately conservative: a false negative just leaves the
 * occurrence pending (status quo), while a false positive would silently
 * hide future cash out of the projection.
 *   - name: normalized bill name must appear in the draft's description /
 *     merchant text (or vice versa), e.g. "NV Energy" ↔ "NVENERGY PAYMENTS".
 *   - date: draft within ±MATCH_WINDOW_DAYS of the occurrence.
 *   - amount: within AMOUNT_TOLERANCE of the expected amount (utility bills
 *     drift month to month; the floor keeps small bills from failing on a
 *     couple dollars of variation).
 *   - one-to-one: each draft settles at most one occurrence and each
 *     occurrence consumes at most one draft (nearest date wins).
 */

import type { BillRow } from "./db/schema";
import { daysBetween } from "./dates";

export const MATCH_WINDOW_DAYS = 20;
/** |draft − expected| must be ≤ max(35% of expected, $25). */
const AMOUNT_TOLERANCE_PCT = 0.35;
const AMOUNT_TOLERANCE_FLOOR_CENTS = 25_00;

export type ReconcilableDraft = {
  id: string;
  date: string; // ISO
  description: string;
  merchantName: string | null;
  amountCents: number; // positive = money out (Plaid convention)
};

export type ReconcilableBill = Pick<
  BillRow,
  "id" | "name" | "amountCents" | "intervalMonths" | "anchorDate"
> & {
  /** Per-occurrence planned amounts (payment overrides), keyed by due date. */
  overridesByDate?: ReadonlyMap<string, number>;
};

export type PaidBillOccurrence = {
  billId: string;
  /** The generated due date this payment settles. */
  occurrenceDate: string;
  draftId: string;
  paidDate: string;
  paidAmountCents: number;
};

function daysInMonthUtc(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** All occurrences of a bill with due date in [startIso, endIso], ascending. */
export function enumerateBillOccurrences(
  bill: Pick<BillRow, "anchorDate" | "intervalMonths">,
  startIso: string,
  endIso: string,
): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bill.anchorDate);
  if (!m || endIso < startIso) return [];
  const aY = Number(m[1]);
  const aM = Number(m[2]);
  const aD = Number(m[3]);
  const interval = Math.max(1, bill.intervalMonths);
  const [sY, sM] = startIso.split("-").map(Number);
  const monthsDiff = (sY! - aY) * 12 + (sM! - aM);
  let k = Math.floor(monthsDiff / interval) - 1;

  const out: string[] = [];
  for (let i = 0; i < 4096; i++, k++) {
    const total = aY * 12 + (aM - 1) + k * interval;
    const year = Math.floor(total / 12);
    const month = ((total % 12) + 12) % 12 + 1;
    const day = Math.min(aD, daysInMonthUtc(year, month));
    const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (iso > endIso) break;
    if (iso >= startIso) out.push(iso);
  }
  return out;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Does the draft's text plausibly name this bill? */
export function draftNamesBill(
  billName: string,
  draft: Pick<ReconcilableDraft, "description" | "merchantName">,
): boolean {
  const bill = normalize(billName);
  if (bill.length < 3) return false; // too short to trust substring matching
  const haystacks = [draft.description, draft.merchantName ?? ""].map(normalize);
  return haystacks.some((h) => h.length >= 3 && (h.includes(bill) || bill.includes(h)));
}

function amountMatches(expectedCents: number, paidCents: number): boolean {
  const tolerance = Math.max(
    Math.round(expectedCents * AMOUNT_TOLERANCE_PCT),
    AMOUNT_TOLERANCE_FLOOR_CENTS,
  );
  return Math.abs(paidCents - expectedCents) <= tolerance;
}

/**
 * Find bill occurrences settled by posted drafts. `drafts` should already be
 * limited to real money-out rows on the accounts whose balance feeds the
 * projection (approved, positive amounts).
 */
export function matchPaidBillOccurrences(
  bills: ReadonlyArray<ReconcilableBill>,
  drafts: ReadonlyArray<ReconcilableDraft>,
  opts: { windowDays?: number } = {},
): PaidBillOccurrence[] {
  const windowDays = opts.windowDays ?? MATCH_WINDOW_DAYS;
  if (bills.length === 0 || drafts.length === 0) return [];

  const spendDrafts = drafts.filter((d) => d.amountCents > 0);
  if (spendDrafts.length === 0) return [];
  const minDraft = spendDrafts.reduce((a, d) => (d.date < a ? d.date : a), spendDrafts[0]!.date);
  const maxDraft = spendDrafts.reduce((a, d) => (d.date > a ? d.date : a), spendDrafts[0]!.date);

  type Candidate = PaidBillOccurrence & { distanceDays: number };
  const candidates: Candidate[] = [];

  for (const bill of bills) {
    // A draft between two adjacent occurrences can be a candidate for both;
    // the nearest-first one-to-one assignment below resolves the ambiguity.
    const window = Math.max(1, windowDays);

    const occStart = addDays(minDraft, -window);
    const occEnd = addDays(maxDraft, window);
    for (const occ of enumerateBillOccurrences(bill, occStart, occEnd)) {
      const expected = bill.overridesByDate?.get(occ) ?? bill.amountCents;
      if (expected <= 0) continue; // zero-planned occurrence has nothing to settle
      for (const draft of spendDrafts) {
        const distance = Math.abs(daysBetween(occ, draft.date));
        if (distance > window) continue;
        if (!draftNamesBill(bill.name, draft)) continue;
        if (!amountMatches(expected, draft.amountCents)) continue;
        candidates.push({
          billId: bill.id,
          occurrenceDate: occ,
          draftId: draft.id,
          paidDate: draft.date,
          paidAmountCents: draft.amountCents,
          distanceDays: distance,
        });
      }
    }
  }

  // Greedy one-to-one assignment, closest date first.
  candidates.sort(
    (a, b) =>
      a.distanceDays - b.distanceDays ||
      a.occurrenceDate.localeCompare(b.occurrenceDate) ||
      a.draftId.localeCompare(b.draftId),
  );
  const usedDrafts = new Set<string>();
  const usedOccurrences = new Set<string>();
  const out: PaidBillOccurrence[] = [];
  for (const c of candidates) {
    const occKey = `${c.billId}:${c.occurrenceDate}`;
    if (usedDrafts.has(c.draftId) || usedOccurrences.has(occKey)) continue;
    usedDrafts.add(c.draftId);
    usedOccurrences.add(occKey);
    out.push({
      billId: c.billId,
      occurrenceDate: c.occurrenceDate,
      draftId: c.draftId,
      paidDate: c.paidDate,
      paidAmountCents: c.paidAmountCents,
    });
  }
  return out;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
