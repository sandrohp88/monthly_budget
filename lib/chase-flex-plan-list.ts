/**
 * Parser + matcher for Chase flexible-financing ("Equal Pay" / My Chase Plan)
 * promo tables — the "QUALIFIED PROMOTIONAL FINANCING" section of a Chase
 * statement, or the plan list on chase.com. Pure — shared by the reconcile API
 * route and the client-side preview, same contract as lib/paypal-promo-list.ts.
 *
 * The canonical paste source is the statement table, whose text-extracted rows
 * look like (columns: Description, Total Qualified, Remaining, Expiration,
 * APR, Deferred Interest Accrued, Deferred Interest, Promo Min Pay):
 *
 *   Equal Pay Promo $146.75 $73.37 10/07/2026 ---- ---- ---- $24.46
 *
 * A multi-line fallback accumulates the same fields across consecutive lines
 * (chase.com plan cards), emitting a row once remaining + expiration are known.
 *
 * Chase-specific matching: statement rows all share the same description
 * ("Equal Pay Promo"), so unlike the PayPal matcher this one keys on the plan
 * EXPIRATION DATE — plans opened in different cycles expire on different due
 * dates, making endDate the stable identifier.
 */

import type { MatchablePromo, PromoReconcilePlan } from "./paypal-promo-list";

export type ChaseFlexPlanRow = {
  description: string;
  /** "Total Qualified Amount" — the original purchase total, when present. */
  originalCents: number | null;
  remainingCents: number;
  endDate: string; // ISO YYYY-MM-DD
  /** "Promo Min Pay" — the fixed plan payment billed each cycle, when present. */
  monthlyPaymentCents: number | null;
};

const AMOUNT_RE = /\$\s*([\d,]+(?:\.\d{1,2})?)/g;
const NUMERIC_DATE_RE = /(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/;
const PERCENT_RE = /\d+(?:\.\d+)?\s*%/g;
const BOILERPLATE_RE =
  /^(qualified promotional|description|total\b|remaining\b|expiration|annual percentage|deferred|promo\s*min|interest|balance type|purchases\b|cash advances|balance transfers|what is|flexible financing offers,|\(v\)|\(d\)|\(a\))/i;

function isoDate(year: number, month: number, day: number): string | null {
  if (year < 100) year += 2000;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

function amountsOf(line: string): number[] {
  // Strip APR tokens ("0.00%") so a percentage never reads as an amount.
  const cleaned = line.replace(PERCENT_RE, " ");
  const out: number[] = [];
  for (const m of cleaned.matchAll(AMOUNT_RE)) {
    const value = Number(m[1]!.replace(/,/g, ""));
    if (Number.isFinite(value)) out.push(Math.round(value * 100));
  }
  return out;
}

function dateOf(line: string): string | null {
  const m = NUMERIC_DATE_RE.exec(line);
  if (!m) return null;
  return isoDate(Number(m[3]), Number(m[1]), Number(m[2]));
}

function descriptionOf(line: string): string {
  // Text before the first $ amount, stripped of column noise.
  const cut = line.split("$")[0] ?? line;
  const stripped = cut
    .replace(NUMERIC_DATE_RE, " ")
    .replace(/-{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped;
}

/**
 * Map a single statement-table row's amounts to fields by column order:
 * [total qualified, remaining, …deferred columns…, promo min pay].
 */
function rowFromAmounts(
  description: string,
  amounts: number[],
  endDate: string,
): ChaseFlexPlanRow | null {
  if (amounts.length === 0) return null;
  if (amounts.length === 1) {
    return { description, originalCents: null, remainingCents: amounts[0]!, endDate, monthlyPaymentCents: null };
  }
  const original = amounts[0]!;
  const remaining = amounts[1]!;
  // Anything after the remaining column is deferred-interest noise except the
  // final Promo Min Pay column. A "min pay" at or above the remaining balance
  // is not a plan payment (mis-split row) — drop it rather than guess.
  const last = amounts.length >= 3 ? amounts[amounts.length - 1]! : null;
  const monthly = last != null && last > 0 && last < remaining ? last : null;
  if (remaining > original) {
    // Column order didn't hold (e.g. partial copy) — trust only the remaining.
    return { description, originalCents: null, remainingCents: remaining, endDate, monthlyPaymentCents: monthly };
  }
  return { description, originalCents: original, remainingCents: remaining, endDate, monthlyPaymentCents: monthly };
}

export function parseChaseFlexPlanList(text: string): ChaseFlexPlanRow[] {
  const rows: ChaseFlexPlanRow[] = [];

  // Block accumulator for the multi-line shape (chase.com plan cards). Unlike
  // the fixed statement-table column order, multi-line fields are labeled by
  // their own line's wording — "$123.23 remaining of $184.87" puts the
  // REMAINING first, so amounts are assigned by label, not position.
  let desc: string | null = null;
  let blockRemaining: number | null = null;
  let blockOriginal: number | null = null;
  let blockMonthly: number | null = null;
  let blockDate: string | null = null;
  const blockHasData = () =>
    blockRemaining != null || blockOriginal != null || blockMonthly != null || blockDate != null;
  const resetBlock = () => {
    desc = null;
    blockRemaining = null;
    blockOriginal = null;
    blockMonthly = null;
    blockDate = null;
  };
  const emitBlock = () => {
    if (blockRemaining != null && blockDate) {
      rows.push({
        description: desc || "Chase flex plan",
        originalCents: blockOriginal,
        remainingCents: blockRemaining,
        endDate: blockDate,
        monthlyPaymentCents:
          blockMonthly != null && blockMonthly > 0 && blockMonthly < blockRemaining
            ? blockMonthly
            : null,
      });
    }
    resetBlock();
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      emitBlock();
      continue;
    }

    const amounts = amountsOf(line);
    const date = dateOf(line);
    const residue = descriptionOf(line);
    const isBoilerplate = BOILERPLATE_RE.test(line);

    // Single-line statement row: two-plus amounts AND an expiration on one
    // line — the fixed column order [total, remaining, …, min pay] applies.
    // A line that says "remaining" labels its own amounts and goes through
    // the labeled path below instead ("$123.23 remaining of $184.87 …").
    if (!isBoilerplate && amounts.length >= 2 && date && !/remaining/i.test(line)) {
      emitBlock(); // whatever was accumulating is a separate (incomplete) block
      const row = rowFromAmounts(residue || "Chase flex plan", amounts, date);
      if (row) rows.push(row);
      continue;
    }

    if (isBoilerplate) continue;

    // Multi-line accumulation.
    if (amounts.length === 0 && date == null) {
      // Pure text line: a new plan's name. A fresh name with data pending
      // means the previous block ended without an expiration — drop it.
      if (residue.length >= 3 && /[a-z]/i.test(residue)) {
        if (blockHasData()) emitBlock();
        desc = residue;
      }
      continue;
    }

    // Assign this line's amounts by its wording.
    if (amounts.length > 0) {
      if (/remaining|balance/i.test(line)) {
        if (blockRemaining == null) blockRemaining = amounts[0]!;
        // "$X remaining of $Y" — the trailing amount is the purchase total.
        if (amounts.length >= 2 && blockOriginal == null) blockOriginal = amounts[amounts.length - 1]!;
      } else if (/payment|monthly|min\b/i.test(line)) {
        if (blockMonthly == null) blockMonthly = amounts[0]!;
      } else if (/\bof\b|total|original|qualified|purchase/i.test(line)) {
        if (blockOriginal == null) blockOriginal = amounts[0]!;
      } else if (blockRemaining == null) {
        blockRemaining = amounts[0]!;
      } else if (blockOriginal == null) {
        blockOriginal = amounts[0]!;
      }
    }
    if (date && !blockDate) blockDate = date;
    if (!desc && residue.length >= 3 && /[a-z]/i.test(residue)) desc = residue;
    if (blockRemaining != null && blockDate) emitBlock();
  }
  emitBlock();
  return rows;
}

/**
 * Cheap detector so the reconcile dialog can auto-route a paste to this parser
 * instead of the PayPal one.
 */
export function looksLikeChaseFlexPlanList(text: string): boolean {
  if (/equal pay|my chase plan|chase pay over time|qualified promotional financing|promo\s*min\s*pay|total qualified/i.test(text)) {
    return true;
  }
  // Two-plus-amount rows carrying an expiration date are the statement-table
  // shape; PayPal lists never put two amounts and a date on one line.
  let tableRows = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (amountsOf(line).length >= 2 && dateOf(line) != null) tableRows++;
  }
  return tableRows >= 1;
}

// ── matching ────────────────────────────────────────────────────────────────

export type ChaseFlexReconcilePlan = {
  updates: Array<{ promoId: string; row: ChaseFlexPlanRow }>;
  creates: ChaseFlexPlanRow[];
  archives: PromoReconcilePlan["archives"];
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Match pasted plans to existing ACTIVE promos. Statement rows share one
 * description, so endDate is the identifier:
 *
 *   1. unique promo with the same endDate AND remaining balance,
 *   2. unique promo with the same endDate,
 *   3. unique normalized-description match (PayPal-style fallback).
 *
 * Each promo matches at most one row; anything ambiguous becomes a create so
 * nothing is guessed. Unmatched active promos are reported for archiving.
 */
export function planChaseFlexReconcile(
  promos: ReadonlyArray<MatchablePromo>,
  rows: ReadonlyArray<ChaseFlexPlanRow>,
): ChaseFlexReconcilePlan {
  const available = new Map(promos.filter((p) => p.isActive).map((p) => [p.id, p] as const));
  const updates: ChaseFlexReconcilePlan["updates"] = [];
  const creates: ChaseFlexPlanRow[] = [];

  const uniqueMatch = (pred: (p: MatchablePromo) => boolean): MatchablePromo | null => {
    const hits = [...available.values()].filter(pred);
    return hits.length === 1 ? hits[0]! : null;
  };

  for (const row of rows) {
    const target = normalize(row.description);
    const matched =
      uniqueMatch((p) => p.endDate === row.endDate && p.remainingAmountCents === row.remainingCents) ??
      uniqueMatch((p) => p.endDate === row.endDate) ??
      uniqueMatch((p) => {
        const n = normalize(p.description);
        return n === target || n.includes(target) || target.includes(n);
      });
    if (matched) {
      updates.push({ promoId: matched.id, row });
      available.delete(matched.id);
    } else {
      creates.push(row);
    }
  }

  const archives = [...available.values()].map((p) => ({
    promoId: p.id,
    description: p.description,
  }));
  return { updates, creates, archives };
}
