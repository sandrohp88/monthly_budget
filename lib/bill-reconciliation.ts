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
 *   - assignment: two phases. Phase 1 gives each occurrence its single
 *     best-amount-fit draft (one draft per occurrence, one occurrence per
 *     draft) so two bills billed the same day — e.g. NV Energy for two
 *     houses — each take the posted amount closest to their estimate instead
 *     of being lumped together. Phase 2 folds any LEFTOVER drafts (more
 *     payments than occurrences) into their nearest occurrence, covering the
 *     genuine one-bill-posts-as-two-ACH-pulls case.
 *   - settle: an occurrence's assigned total must reach SETTLE_MIN_FRACTION of
 *     the planned amount. Over-payment settles too (plans are estimates); the
 *     paid marker shows the real posted total.
 */

import type { BillRow } from "./db/schema";
import { daysBetween } from "./dates";

export const MATCH_WINDOW_DAYS = 20;
/**
 * Posted total must reach this fraction of the planned amount to settle the
 * occurrence. Guards against a tiny stray same-name charge marking a large
 * bill as paid, while tolerating planned amounts set well above the actual
 * (e.g. a $300 high-water utility estimate vs ~$180 posted).
 */
export const SETTLE_MIN_FRACTION = 0.35;

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
  /** Every posted draft that contributed to the settlement. */
  draftIds: string[];
  /** Latest posting date among the contributing drafts. */
  paidDate: string;
  /** Sum of the contributing drafts — the real cash that left the account. */
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
  const windowDays = Math.max(1, opts.windowDays ?? MATCH_WINDOW_DAYS);
  if (bills.length === 0 || drafts.length === 0) return [];

  const spendDrafts = drafts.filter((d) => d.amountCents > 0);
  if (spendDrafts.length === 0) return [];
  const minDraft = spendDrafts.reduce((a, d) => (d.date < a ? d.date : a), spendDrafts[0]!.date);
  const maxDraft = spendDrafts.reduce((a, d) => (d.date > a ? d.date : a), spendDrafts[0]!.date);

  type Occurrence = {
    key: string;
    billId: string;
    billName: string;
    occurrenceDate: string;
    expectedCents: number;
  };
  const occurrences: Occurrence[] = [];
  for (const bill of bills) {
    const occStart = addDays(minDraft, -windowDays);
    const occEnd = addDays(maxDraft, windowDays);
    for (const occ of enumerateBillOccurrences(bill, occStart, occEnd)) {
      const expected = bill.overridesByDate?.get(occ) ?? bill.amountCents;
      if (expected <= 0) continue; // zero-planned occurrence has nothing to settle
      occurrences.push({
        key: `${bill.id}:${occ}`,
        billId: bill.id,
        billName: bill.name,
        occurrenceDate: occ,
        expectedCents: expected,
      });
    }
  }
  if (occurrences.length === 0) return [];

  // Eligible (occurrence, draft) pairs: same name, within the date window.
  type Pair = {
    occ: Occurrence;
    draft: ReconcilableDraft;
    distanceDays: number;
    amountGapCents: number;
  };
  const pairs: Pair[] = [];
  for (const occ of occurrences) {
    for (const draft of spendDrafts) {
      const distance = Math.abs(daysBetween(occ.occurrenceDate, draft.date));
      if (distance > windowDays) continue;
      if (!draftNamesBill(occ.billName, draft)) continue;
      pairs.push({
        occ,
        draft,
        distanceDays: distance,
        amountGapCents: Math.abs(draft.amountCents - occ.expectedCents),
      });
    }
  }
  if (pairs.length === 0) return [];

  const assignedDraftIds = new Set<string>();
  const draftsByOcc = new Map<string, ReconcilableDraft[]>();
  const addToOcc = (key: string, draft: ReconcilableDraft) => {
    const list = draftsByOcc.get(key) ?? [];
    list.push(draft);
    draftsByOcc.set(key, list);
  };

  // Phase 1 — best amount fit, ONE draft per occurrence and ONE occurrence per
  // draft. This keeps two bills billed on the same day separate (e.g. NV Energy
  // for two houses): each takes the posted amount closest to its estimate,
  // instead of both being summed onto one bill.
  const occupiedOccs = new Set<string>();
  const byAmountFit = [...pairs].sort(
    (a, b) =>
      a.amountGapCents - b.amountGapCents ||
      a.distanceDays - b.distanceDays ||
      a.occ.key.localeCompare(b.occ.key) ||
      a.draft.id.localeCompare(b.draft.id),
  );
  for (const p of byAmountFit) {
    if (assignedDraftIds.has(p.draft.id) || occupiedOccs.has(p.occ.key)) continue;
    assignedDraftIds.add(p.draft.id);
    occupiedOccs.add(p.occ.key);
    addToOcc(p.occ.key, p.draft);
  }

  // Phase 2 — one bill can genuinely post as several partial pulls. Any draft
  // left over after phase 1 (more drafts than occurrences to absorb them) folds
  // into its nearest eligible occurrence, which may already hold a phase-1 draft.
  const byDate = [...pairs].sort(
    (a, b) =>
      a.distanceDays - b.distanceDays ||
      a.amountGapCents - b.amountGapCents ||
      a.occ.key.localeCompare(b.occ.key),
  );
  for (const p of byDate) {
    if (assignedDraftIds.has(p.draft.id)) continue;
    assignedDraftIds.add(p.draft.id);
    addToOcc(p.occ.key, p.draft);
  }

  const occByKey = new Map(occurrences.map((o) => [o.key, o]));
  const out: PaidBillOccurrence[] = [];
  for (const [key, assigned] of draftsByOcc) {
    const occ = occByKey.get(key)!;
    const paidAmountCents = assigned.reduce((s, d) => s + d.amountCents, 0);
    if (paidAmountCents < Math.round(occ.expectedCents * SETTLE_MIN_FRACTION)) continue;
    out.push({
      billId: occ.billId,
      occurrenceDate: occ.occurrenceDate,
      draftIds: assigned.map((d) => d.id).sort(),
      paidDate: assigned.reduce((a, d) => (d.date > a ? d.date : a), assigned[0]!.date),
      paidAmountCents,
    });
  }
  out.sort(
    (a, b) => a.billId.localeCompare(b.billId) || a.occurrenceDate.localeCompare(b.occurrenceDate),
  );
  return out;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
