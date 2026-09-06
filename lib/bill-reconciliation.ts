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
 *     A per-bill alias list (descriptors of drafts the user manually linked
 *     to the bill in the past) widens this gate: banks post the same wording
 *     every month, so one manual link teaches all future cycles.
 *   - manual link: a draft with `linkedBillId` set pairs ONLY with that
 *     bill's occurrences and skips the name gate entirely — the user's
 *     explicit assignment beats the heuristic. Linked pairs are assigned
 *     before heuristic pairs so a same-day heuristic match can't steal the
 *     occurrence.
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
  /** Manual user assignment: this draft pays that bill (see module docs). */
  linkedBillId?: string | null;
  /**
   * User rejected this draft's heuristic match ("not this bill"): it never
   * name/alias-matches any bill. An explicit linkedBillId still wins — the
   * exclusion only silences the heuristic.
   */
  billMatchExcluded?: boolean;
  /**
   * The user divided this transaction across the obligations it actually paid
   * (see `draft_allocations`). Allocations are EXHAUSTIVE: a draft carrying
   * any of them is removed from heuristic matching entirely, so the same
   * dollars can't be credited twice. Any unallocated remainder stays
   * unattributed rather than being quietly reassigned.
   */
  allocations?: ReadonlyArray<DraftAllocation>;
};

/** One portion of a transaction, aimed at one dated obligation. */
export type DraftAllocation = {
  targetKind: ObligationKind;
  targetId: string;
  targetDate: string;
  amountCents: number;
};

export type ObligationKind = "bill" | "extra" | "card_payment";

export type ReconcilableBill = Pick<
  BillRow,
  "id" | "name" | "amountCents" | "intervalMonths" | "anchorDate"
> & {
  /** Per-occurrence planned amounts (payment overrides), keyed by due date. */
  overridesByDate?: ReadonlyMap<string, number>;
};

/**
 * A one-time expense, as the matcher sees it. A recurring bill generates many
 * dated amounts; a one-time expense IS one — so once both are reduced to
 * "an obligation with a date and a planned amount" the same matcher settles
 * either, and one-time expenses stop being invisible to reconciliation.
 */
export type ReconcilableExtra = {
  id: string;
  description: string;
  date: string;
  amountCents: number;
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

/** The settled one-time-expense analogue of PaidBillOccurrence. */
export type PaidExtra = {
  extraId: string;
  draftIds: string[];
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

/**
 * Split a bill's user-entered `matchAlias` column into individual aliases.
 * Comma-separated; blank and too-short-to-trust entries (under 3 chars after
 * trimming) are dropped, mirroring the containment matcher's own guard.
 */
export function billAliasList(matchAlias: string | null | undefined): string[] {
  if (!matchAlias) return [];
  return matchAlias
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
}

/**
 * Does the draft's text match any learned alias — the descriptor of a draft
 * the user previously linked to this bill by hand? Same containment rules as
 * draftNamesBill, applied alias-by-alias.
 */
export function draftMatchesAlias(
  aliases: ReadonlyArray<string> | undefined,
  draft: Pick<ReconcilableDraft, "description" | "merchantName">,
): boolean {
  if (!aliases || aliases.length === 0) return false;
  const haystacks = [draft.description, draft.merchantName ?? ""]
    .map(normalize)
    .filter((h) => h.length >= 3);
  return aliases.some((alias) => {
    const a = normalize(alias);
    if (a.length < 3) return false;
    return haystacks.some((h) => h.includes(a) || a.includes(h));
  });
}

/**
 * Resolve the user's EXPLICIT splits — one transaction divided across the
 * obligations it actually paid.
 *
 * This exists because a single transfer routinely settles more than one
 * thing (the case that prompted it: $4,000 covering a $2,000 recurring bill
 * plus a $2,000 one-off), and every other path in this file can credit a
 * draft to exactly one occurrence. Heuristics cannot recover a split — only
 * the person who sent the money knows how it divides — so this is the one
 * mechanism that takes the answer directly.
 *
 * Returns the settlements plus the draft ids and occurrence keys it consumed,
 * so the heuristic pass can skip both and never double-credit the same money.
 */
export function matchAllocatedObligations(
  bills: ReadonlyArray<ReconcilableBill>,
  extras: ReadonlyArray<ReconcilableExtra>,
  drafts: ReadonlyArray<ReconcilableDraft>,
): {
  bills: PaidBillOccurrence[];
  extras: PaidExtra[];
  allocatedDraftIds: Set<string>;
  allocatedOccurrenceKeys: Set<string>;
} {
  const allocatedDraftIds = new Set<string>();
  const allocatedOccurrenceKeys = new Set<string>();
  const billById = new Map(bills.map((b) => [b.id, b] as const));
  const extraById = new Map(extras.map((e) => [e.id, e] as const));

  type Bucket = { draftIds: string[]; paidDate: string; amountCents: number };
  const buckets = new Map<string, Bucket & { kind: ObligationKind; id: string; date: string }>();

  for (const draft of drafts) {
    const allocations = draft.allocations ?? [];
    if (allocations.length === 0) continue;
    // Exhaustive: this draft is now fully accounted for by the user's own
    // breakdown and must not also be offered to the heuristic matcher.
    allocatedDraftIds.add(draft.id);
    for (const a of allocations) {
      if (a.amountCents <= 0 || a.targetKind === "card_payment") continue;
      const key = `${a.targetKind}:${a.targetId}:${a.targetDate}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.draftIds.push(draft.id);
        existing.amountCents += a.amountCents;
        if (draft.date > existing.paidDate) existing.paidDate = draft.date;
      } else {
        buckets.set(key, {
          kind: a.targetKind,
          id: a.targetId,
          date: a.targetDate,
          draftIds: [draft.id],
          paidDate: draft.date,
          amountCents: a.amountCents,
        });
      }
    }
  }

  const paidBills: PaidBillOccurrence[] = [];
  const paidExtras: PaidExtra[] = [];
  for (const b of buckets.values()) {
    // Same settle floor as a manual bill link: the user's word decides WHICH
    // obligation the money went to, not whether a token amount clears it.
    if (b.kind === "bill") {
      const bill = billById.get(b.id);
      if (!bill) continue;
      const expected = bill.overridesByDate?.get(b.date) ?? bill.amountCents;
      allocatedOccurrenceKeys.add(occurrenceKey(b.id, b.date));
      if (expected > 0 && b.amountCents < Math.round(expected * SETTLE_MIN_FRACTION)) continue;
      paidBills.push({
        billId: b.id,
        occurrenceDate: b.date,
        draftIds: [...b.draftIds].sort(),
        paidDate: b.paidDate,
        paidAmountCents: b.amountCents,
      });
    } else {
      const extra = extraById.get(b.id);
      if (!extra) continue;
      if (extra.amountCents > 0 && b.amountCents < Math.round(extra.amountCents * SETTLE_MIN_FRACTION)) {
        continue;
      }
      paidExtras.push({
        extraId: b.id,
        draftIds: [...b.draftIds].sort(),
        paidDate: b.paidDate,
        paidAmountCents: b.amountCents,
      });
    }
  }

  paidBills.sort(
    (a, b) => a.billId.localeCompare(b.billId) || a.occurrenceDate.localeCompare(b.occurrenceDate),
  );
  paidExtras.sort((a, b) => a.extraId.localeCompare(b.extraId));
  return { bills: paidBills, extras: paidExtras, allocatedDraftIds, allocatedOccurrenceKeys };
}

/**
 * Find bill occurrences settled by posted drafts. `drafts` should already be
 * limited to real money-out rows on the accounts whose balance feeds the
 * projection (approved, positive amounts).
 *
 * One-time expenses are deliberately NOT matched here. A recurring bill posts
 * the same wording every month, which is what makes name matching safe; a
 * one-off purchase has no such history, so a heuristic guess would be far more
 * likely to hide real cash than to help. Extras settle by explicit allocation
 * only — see matchAllocatedObligations.
 */
export function matchPaidBillOccurrences(
  bills: ReadonlyArray<ReconcilableBill>,
  drafts: ReadonlyArray<ReconcilableDraft>,
  opts: {
    windowDays?: number;
    /** Learned descriptor aliases per bill id (from past manual links). */
    aliasesByBill?: ReadonlyMap<string, ReadonlyArray<string>>;
    /** Draft ids the user already split explicitly — see matchAllocatedObligations. */
    excludeDraftIds?: ReadonlySet<string>;
    /** `${billId}:${date}` keys an explicit allocation already spoke for. */
    excludeOccurrenceKeys?: ReadonlySet<string>;
  } = {},
): PaidBillOccurrence[] {
  const windowDays = Math.max(1, opts.windowDays ?? MATCH_WINDOW_DAYS);
  if (bills.length === 0 || drafts.length === 0) return [];

  // A draft the user has split is spoken for in full; an occurrence an
  // allocation names is likewise settled (or deliberately left short). Both
  // drop out here so the heuristic can't credit the same money a second time.
  const spendDrafts = drafts.filter(
    (d) => d.amountCents > 0 && !opts.excludeDraftIds?.has(d.id),
  );
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
      if (opts.excludeOccurrenceKeys?.has(occurrenceKey(bill.id, occ))) continue;
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

  // Eligible (occurrence, draft) pairs within the date window. A manually
  // linked draft pairs only with its bill and skips the name gate; heuristic
  // drafts need a name or learned-alias match.
  type Pair = {
    occ: Occurrence;
    draft: ReconcilableDraft;
    linked: boolean;
    distanceDays: number;
    amountGapCents: number;
  };
  const pairs: Pair[] = [];
  for (const occ of occurrences) {
    const aliases = opts.aliasesByBill?.get(occ.billId);
    for (const draft of spendDrafts) {
      const distance = Math.abs(daysBetween(occ.occurrenceDate, draft.date));
      if (distance > windowDays) continue;
      const linked = draft.linkedBillId != null;
      if (linked) {
        if (draft.linkedBillId !== occ.billId) continue;
      } else if (
        draft.billMatchExcluded ||
        (!draftNamesBill(occ.billName, draft) && !draftMatchesAlias(aliases, draft))
      ) {
        continue;
      }
      pairs.push({
        occ,
        draft,
        linked,
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
  // instead of both being summed onto one bill. Manually linked pairs go
  // first regardless of fit — the user's assignment must not lose its
  // occurrence to a heuristic draft with a closer amount.
  const occupiedOccs = new Set<string>();
  const byAmountFit = [...pairs].sort(
    (a, b) =>
      Number(b.linked) - Number(a.linked) ||
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

/** ACH posting lag: don't call a bill unpaid until this many days after due. */
export const OVERDUE_GRACE_DAYS = 2;
/** How far back to look for unpaid occurrences before going quiet about them. */
export const OVERDUE_LOOKBACK_DAYS = 12;

export type UnpaidRecentOccurrence = {
  billId: string;
  billName: string;
  dueDate: string;
  expectedCents: number;
};

/**
 * A user's assertion about one occurrence, for occurrences the transaction
 * feed hasn't answered yet. Mirrors a `bill_payment_states` row.
 */
export type BillPaymentMark = {
  billId: string;
  dueDate: string;
  state: "sent" | "paid_externally";
  /** What actually left the account; null falls back to the planned amount. */
  amountCents: number | null;
  /** ISO date the money left — where a `sent` hold is placed. */
  markedDate: string;
};

/** `${billId}:${dueDate}` — the identity of a generated occurrence. */
export function occurrenceKey(billId: string, dueDate: string): string {
  return `${billId}:${dueDate}`;
}

export type HeldBillOccurrence = {
  billId: string;
  billName: string;
  dueDate: string;
  /** Cash still held for this occurrence. */
  amountCents: number;
  /**
   * `sent` — the user said the money is out, waiting to post.
   * `unconfirmed` — due date reached and nothing has confirmed it either way.
   */
  reason: "sent" | "unconfirmed";
  /**
   * The day the hold should debit: the date the money left for a `sent` mark,
   * the due date otherwise. The projection floors this at its start date, so
   * an occurrence older than the visible window rides forward to the first
   * rendered day rather than silently disappearing.
   */
  holdDate: string;
};

/**
 * Occurrences whose cash must STILL be held because nothing has shown it
 * leaving the account.
 *
 * The rule this replaces was "a due date in the past means it was paid", which
 * is an assumption, not evidence — and it fails in the most expensive
 * direction: it releases cash the bank has not yet moved, so the projected
 * balance reads high for exactly as long as the payment takes to post.
 *
 * Precedence, strongest evidence first:
 *   1. a matched posted transaction (`paidOccurrences`) — real money moved,
 *      the live balance already reflects it, hold nothing.
 *   2. `paid_externally` — the user says it was paid from an account this app
 *      can't see. No transaction will ever arrive; release the cash.
 *   3. `sent` — the user says the money is out but unposted. Hold it on the
 *      date they say it left.
 *   4. nothing at all, due date reached — hold it. Conservative by design:
 *      a false hold is visible and one click from being resolved, while a
 *      false release silently overstates every downstream balance.
 *
 * Case 4 is bounded by `lookbackDays` (default OVERDUE_LOOKBACK_DAYS, the same
 * window as the unpaid alert, so the cash hold and the nag always describe the
 * same set of occurrences). Past that, an occurrence that never matched is
 * assumed to have been paid outside the linked accounts and goes quiet.
 *
 * There is deliberately NO grace period here. `findUnpaidRecentOccurrences`
 * waits a couple of days before nagging because a false alarm is annoying; a
 * hold has the opposite cost profile, and the day a bill comes due is exactly
 * when its cash stops being spendable.
 */
export function findHeldOccurrences(
  bills: ReadonlyArray<ReconcilableBill>,
  paidOccurrences: ReadonlyMap<string, ReadonlyArray<{ date: string }>>,
  marks: ReadonlyArray<BillPaymentMark>,
  opts: { today: string; lookbackDays?: number },
): HeldBillOccurrence[] {
  const lookback = Math.max(1, opts.lookbackDays ?? OVERDUE_LOOKBACK_DAYS);
  const windowStart = addDays(opts.today, -lookback);
  const marksByKey = new Map(marks.map((m) => [occurrenceKey(m.billId, m.dueDate), m] as const));

  const out: HeldBillOccurrence[] = [];
  for (const bill of bills) {
    const paidDates = new Set((paidOccurrences.get(bill.id) ?? []).map((p) => p.date));
    // `sent` marks can sit outside the unconfirmed window in both directions —
    // a bill paid early (due date still ahead) or one marked a while ago that
    // still hasn't posted — so enumerate wide enough to reach them.
    const markDates = marks
      .filter((m) => m.billId === bill.id && m.state === "sent")
      .map((m) => m.dueDate);
    const scanStart = markDates.reduce((a, d) => (d < a ? d : a), windowStart);
    const scanEnd = markDates.reduce((a, d) => (d > a ? d : a), opts.today);

    for (const occ of enumerateBillOccurrences(bill, scanStart, scanEnd)) {
      if (paidDates.has(occ)) continue; // (1) reality beats every claim
      const mark = marksByKey.get(occurrenceKey(bill.id, occ));
      if (mark?.state === "paid_externally") continue; // (2) settled, not held
      const planned = bill.overridesByDate?.get(occ) ?? bill.amountCents;

      if (mark?.state === "sent") {
        const amountCents = mark.amountCents ?? planned;
        if (amountCents <= 0) continue;
        out.push({
          billId: bill.id,
          billName: bill.name,
          dueDate: occ,
          amountCents,
          reason: "sent",
          // A mark can't claim money left in the future.
          holdDate: mark.markedDate > opts.today ? opts.today : mark.markedDate,
        });
        continue;
      }

      // (4) unconfirmed — only for occurrences already due, inside the window.
      if (occ > opts.today || occ < windowStart) continue;
      if (planned <= 0) continue; // zero-planned occurrence has nothing to hold
      out.push({
        billId: bill.id,
        billName: bill.name,
        dueDate: occ,
        amountCents: planned,
        reason: "unconfirmed",
        holdDate: occ,
      });
    }
  }
  out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.billName.localeCompare(b.billName));
  return out;
}

/**
 * Occurrences the user has settled by hand (`paid_externally`) — paid from an
 * account this app can't see, so no transaction will ever reconcile them.
 * They render as paid markers exactly like a matched payment would.
 */
export function findExternallyPaidOccurrences(
  marks: ReadonlyArray<BillPaymentMark>,
): Array<{ billId: string; dueDate: string; amountCents: number | null }> {
  return marks
    .filter((m) => m.state === "paid_externally")
    .map((m) => ({ billId: m.billId, dueDate: m.dueDate, amountCents: m.amountCents }));
}

/**
 * Recently-due bill occurrences with NO matched payment — the inverse of the
 * paid markers, for a "was this actually paid?" alert. Only meaningful in
 * linked mode (without transaction data every occurrence would flag).
 *
 * The window is deliberately short: `graceDays` after the due date absorbs
 * ACH posting lag, and anything older than `lookbackDays` goes quiet instead
 * of nagging forever about bills paid outside the linked accounts.
 *
 * An occurrence the user has already answered for — `sent` or
 * `paid_externally` — drops out via `answeredKeys`. They told us; the alert's
 * whole question is settled even though no transaction posted.
 */
export function findUnpaidRecentOccurrences(
  bills: ReadonlyArray<ReconcilableBill>,
  paidOccurrences: ReadonlyMap<string, ReadonlyArray<{ date: string }>>,
  opts: {
    today: string;
    graceDays?: number;
    lookbackDays?: number;
    answeredKeys?: ReadonlySet<string>;
  },
): UnpaidRecentOccurrence[] {
  const grace = Math.max(0, opts.graceDays ?? OVERDUE_GRACE_DAYS);
  const lookback = Math.max(1, opts.lookbackDays ?? OVERDUE_LOOKBACK_DAYS);
  const windowEnd = addDays(opts.today, -grace);
  const windowStart = addDays(opts.today, -lookback);
  if (windowEnd < windowStart) return [];

  const out: UnpaidRecentOccurrence[] = [];
  for (const bill of bills) {
    const paidDates = new Set((paidOccurrences.get(bill.id) ?? []).map((p) => p.date));
    for (const occ of enumerateBillOccurrences(bill, windowStart, windowEnd)) {
      if (paidDates.has(occ)) continue;
      if (opts.answeredKeys?.has(occurrenceKey(bill.id, occ))) continue;
      const expected = bill.overridesByDate?.get(occ) ?? bill.amountCents;
      if (expected <= 0) continue; // zero-planned occurrence needs no payment
      out.push({ billId: bill.id, billName: bill.name, dueDate: occ, expectedCents: expected });
    }
  }
  out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.billName.localeCompare(b.billName));
  return out;
}
