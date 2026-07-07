/**
 * Parser + matcher for text copied out of PayPal's "Promotional purchases"
 * (special financing) page. Pure — shared by the reconcile API route and the
 * client-side preview so what the user sees is what the server applies.
 *
 * PayPal's markup changes; the parser is deliberately forgiving. It scans
 * line-by-line and accumulates blocks of (description, $amount, payoff date).
 * A block is emitted as soon as all three parts are present; lines that are
 * pure boilerplate ("No interest if paid in full by …") contribute their date
 * but are never taken as a description.
 */

export type PayPalPromoListRow = {
  description: string;
  remainingCents: number;
  endDate: string; // ISO YYYY-MM-DD
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const AMOUNT_RE = /\$\s*([\d,]+(?:\.\d{1,2})?)/;
const NUMERIC_DATE_RE = /(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/;
const NAMED_DATE_RE =
  /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i;
const BOILERPLATE_RE =
  /^(no interest|interest will|promotional|special financing|remaining|paid in full|expires?|payoff|pay off|minimum|due date|balance|est\b|as of|learn more)/i;

function isoDate(year: number, month: number, day: number): string | null {
  if (year < 100) year += 2000;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

function extractAmountCents(line: string): number | null {
  const m = AMOUNT_RE.exec(line);
  if (!m?.[1]) return null;
  const normalized = m[1].replace(/,/g, "");
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function extractDate(line: string): string | null {
  const named = NAMED_DATE_RE.exec(line);
  if (named) {
    const month = MONTHS[named[1]!.toLowerCase()];
    if (month) {
      const iso = isoDate(Number(named[3]), month, Number(named[2]));
      if (iso) return iso;
    }
  }
  const numeric = NUMERIC_DATE_RE.exec(line);
  if (numeric) {
    return isoDate(Number(numeric[3]), Number(numeric[1]), Number(numeric[2]));
  }
  return null;
}

/** Residual text of a line once amount/date tokens are stripped. */
function descriptionResidue(line: string): string {
  const stripped = line
    .replace(AMOUNT_RE, " ")
    .replace(NAMED_DATE_RE, " ")
    .replace(NUMERIC_DATE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped;
}

export function parsePayPalPromoList(text: string): PayPalPromoListRow[] {
  const rows: PayPalPromoListRow[] = [];
  let desc: string | null = null;
  let remainingCents: number | null = null;
  let endDate: string | null = null;

  const reset = () => {
    desc = null;
    remainingCents = null;
    endDate = null;
  };
  const emitIfComplete = () => {
    if (desc && remainingCents != null && endDate) {
      rows.push({ description: desc, remainingCents, endDate });
      reset();
    }
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      // Blank line: hard block boundary. Incomplete blocks are dropped —
      // better than a phantom row or a header leaking into the next block.
      emitIfComplete();
      reset();
      continue;
    }

    const amount = extractAmountCents(line);
    const date = extractDate(line);
    const residue = descriptionResidue(line);
    const hasResidue = residue.length >= 3 && /[a-z]/i.test(residue);
    const isBoilerplate = BOILERPLATE_RE.test(line);
    // Only a line with NO amount/date tokens can start a block — date carrier
    // lines ("by 07/26/2026") leave residue like "by" that must not be a name.
    const isDescriptionLine = !isBoilerplate && amount == null && date == null && hasResidue;

    if (isDescriptionLine) {
      // A fresh description while the block already has data means a new
      // promo started (stacked format without blank separators). Without
      // data, the nearest line preceding the amount wins (replaces a header).
      if (desc && (remainingCents != null || endDate)) {
        emitIfComplete();
        reset();
      }
      desc = residue;
    } else {
      if (amount != null && remainingCents == null) remainingCents = amount;
      if (date && !endDate) endDate = date;
      // Single-line table rows carry the description alongside the tokens.
      if (!desc && !isBoilerplate && hasResidue) desc = residue;
    }

    emitIfComplete();
  }
  emitIfComplete();
  return rows;
}

// ── matching ────────────────────────────────────────────────────────────────

export type MatchablePromo = {
  id: string;
  description: string;
  remainingAmountCents: number;
  endDate: string;
  isActive: boolean;
};

export type PromoReconcilePlan = {
  /** Existing promo → new values from the pasted list. */
  updates: Array<{ promoId: string; row: PayPalPromoListRow }>;
  /** List rows with no matching promo — become new authoritative promos. */
  creates: PayPalPromoListRow[];
  /** Active promos absent from the pasted list — PayPal says they're gone. */
  archives: Array<{ promoId: string; description: string }>;
};

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Match pasted rows to existing ACTIVE promos: exact normalized-description
 * equality first, then a unique substring match. Each promo matches at most
 * one row; ambiguous rows fall through to `creates` so nothing is guessed.
 */
export function planPromoReconcile(
  promos: ReadonlyArray<MatchablePromo>,
  rows: ReadonlyArray<PayPalPromoListRow>,
): PromoReconcilePlan {
  const active = promos.filter((p) => p.isActive);
  const available = new Map(active.map((p) => [p.id, p] as const));
  const updates: PromoReconcilePlan["updates"] = [];
  const creates: PayPalPromoListRow[] = [];

  for (const row of rows) {
    const target = normalize(row.description);
    let matched =
      [...available.values()].find((p) => normalize(p.description) === target) ?? null;
    if (!matched) {
      const partial = [...available.values()].filter((p) => {
        const n = normalize(p.description);
        return n.includes(target) || target.includes(n);
      });
      matched = partial.length === 1 ? partial[0]! : null;
    }
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
