/**
 * Current-cycle card spending, from real posted transactions.
 *
 * The forecast (lib/card-forecast.ts) answers "what will the cards cost over
 * the coming months" from statements and estimates. This answers the more
 * immediate question: **what has actually hit each card since its last
 * statement closed** — i.e. what the next statement is shaping up to be — and
 * **how full the card is** against its credit line.
 *
 * Pure: takes cards, their open-cycle windows, and the posted transactions on
 * their linked Plaid accounts. No I/O.
 *
 * Two numbers that are easy to conflate:
 *  - `cycleSpendCents` — charges posted INSIDE the open cycle window. This is
 *    what lands on the next statement. It is NOT the card balance: the balance
 *    also carries anything unpaid from previous cycles.
 *  - `balanceCents` — what the issuer says you owe right now, across all
 *    cycles. Utilization is computed from this, because that is what the
 *    issuer reports to the bureaus.
 */

import { looksLikeCardPayment } from "./plaid-transaction-kind";
import type { CardTransaction } from "./repos";

/**
 * A payment toward the card is not spend — it moves the balance down, it does
 * not add to the next statement. The repo query already drops rows classified
 * `card_payment` at sync time, but rows synced BEFORE that classification
 * existed (migration 0015), or synced while the account wasn't yet linked to a
 * card, are still stored as `expense`. Without this second gate those legacy
 * "ONLINE PAYMENT, THANK YOU" / "Payment Thank You - Web" rows net against real
 * charges and a cycle can read as NEGATIVE spend.
 *
 * Reuses the same predicate the sync classifier uses, so the two can't drift.
 * Note what this deliberately does NOT exclude: statement credits, rewards
 * redemptions, and merchant refunds are all legitimate reductions to the next
 * statement and keep netting out.
 */
function isCardPayment(t: CardTransaction): boolean {
  return looksLikeCardPayment({
    primaryCategory: t.plaidCategory,
    description: t.description,
    amountCents: t.amountCents,
  });
}

/** Utilization band. Thresholds follow the common 30% / 70% credit guidance. */
export type UtilizationBand = "low" | "moderate" | "high" | "maxed";

export function utilizationBand(ratio: number): UtilizationBand {
  if (ratio >= 0.9) return "maxed";
  if (ratio >= 0.7) return "high";
  if (ratio >= 0.3) return "moderate";
  return "low";
}

export type CardSpendingInput = {
  cardId: string;
  cardName: string;
  /** The card's linked Plaid account id, when linked. */
  accountId: string | null;
  /** Best-known current balance, or null when unknown (manual card, no entry). */
  balanceCents: number | null;
  /** Credit line, or null when unknown. */
  creditLimitCents: number | null;
  /** Open billing cycle, inclusive both ends (from currentCycleWindow). */
  window: { start: string; end: string };
};

export type CardSpending = {
  cardId: string;
  cardName: string;
  window: { start: string; end: string };
  /** Charges posted in the open cycle so far (refunds net out). */
  cycleSpendCents: number;
  /** How many posted transactions make up `cycleSpendCents`. */
  transactionCount: number;
  /** Days remaining until the cycle closes; 0 on the closing day itself. */
  daysToClose: number;
  /** Average spend per elapsed day of the cycle, for the "on pace" read. */
  dailyPaceCents: number;
  /** Cycle spend extrapolated at the current pace through the closing date. */
  projectedCycleSpendCents: number;
  balanceCents: number | null;
  creditLimitCents: number | null;
  /** balance / limit, or null when either is unknown. Not clamped — over-limit reads > 1. */
  utilization: number | null;
  headroomCents: number | null;
  band: UtilizationBand | null;
  /** Biggest charges first, for the "where did it go" list. */
  topTransactions: CardTransaction[];
  /** Spend by Plaid category, biggest first. */
  byCategory: Array<{ category: string; amountCents: number; count: number }>;
};

export type CardSpendingSummary = {
  cards: CardSpending[];
  totalCycleSpendCents: number;
  totalBalanceCents: number;
  /** Only sums cards whose limit is known — see `cardsWithoutLimit`. */
  totalLimitCents: number;
  overallUtilization: number | null;
  cardsWithoutLimit: number;
  /** Cards at or above the "high" band, worst first. */
  crowded: CardSpending[];
};

const UNCATEGORIZED = "Uncategorized";

/**
 * Plaid's personal-finance categories arrive as SCREAMING_SNAKE enums
 * ("GENERAL_MERCHANDISE"). Render them as prose instead of shouting the raw
 * key at the user. Anything already in prose (a hand-entered category) passes
 * through untouched.
 */
export function formatCategoryLabel(category: string): string {
  if (!/^[A-Z0-9_]+$/.test(category)) return category;
  const words = category.toLowerCase().split("_").filter(Boolean);
  if (words.length === 0) return category;
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export type BuildCardSpendingInput = {
  cards: CardSpendingInput[];
  /** Posted transactions across all the cards' accounts, any date. */
  transactions: CardTransaction[];
  today: string;
  /** How many transactions to keep per card for the detail list. Default 8. */
  topN?: number;
};

function daysBetweenIso(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  return Math.round((db - da) / 86_400_000);
}

export function buildCardSpending(input: BuildCardSpendingInput): CardSpendingSummary {
  const { cards, transactions, today } = input;
  const topN = input.topN ?? 8;

  const byAccount = new Map<string, CardTransaction[]>();
  for (const t of transactions) {
    const list = byAccount.get(t.accountId) ?? [];
    list.push(t);
    byAccount.set(t.accountId, list);
  }

  const out: CardSpending[] = cards.map((card) => {
    // Cycle-to-date: the window's start through today, never past the close.
    const windowEnd = today < card.window.end ? today : card.window.end;
    const inCycle = (card.accountId ? (byAccount.get(card.accountId) ?? []) : []).filter(
      (t) => t.date >= card.window.start && t.date <= windowEnd && !isCardPayment(t),
    );

    const cycleSpendCents = inCycle.reduce((s, t) => s + t.amountCents, 0);

    // Elapsed days is inclusive of today, so a cycle's first day divides by 1
    // rather than 0 — the pace on day one is simply that day's spend.
    const elapsedDays = Math.max(1, daysBetweenIso(card.window.start, windowEnd) + 1);
    const totalDays = Math.max(1, daysBetweenIso(card.window.start, card.window.end) + 1);
    const dailyPaceCents = Math.round(cycleSpendCents / elapsedDays);
    const projectedCycleSpendCents = Math.max(
      cycleSpendCents,
      Math.round(dailyPaceCents * totalDays),
    );

    const limit = card.creditLimitCents;
    const balance = card.balanceCents;
    const utilization = limit != null && limit > 0 && balance != null ? balance / limit : null;

    const categoryTotals = new Map<string, { amountCents: number; count: number }>();
    for (const t of inCycle) {
      const key = t.plaidCategory?.trim() || UNCATEGORIZED;
      const entry = categoryTotals.get(key) ?? { amountCents: 0, count: 0 };
      entry.amountCents += t.amountCents;
      entry.count += 1;
      categoryTotals.set(key, entry);
    }

    return {
      cardId: card.cardId,
      cardName: card.cardName,
      window: card.window,
      cycleSpendCents,
      transactionCount: inCycle.length,
      daysToClose: Math.max(0, daysBetweenIso(today, card.window.end)),
      dailyPaceCents,
      projectedCycleSpendCents,
      balanceCents: balance,
      creditLimitCents: limit,
      utilization,
      headroomCents: limit != null && balance != null ? limit - balance : null,
      band: utilization != null ? utilizationBand(utilization) : null,
      topTransactions: [...inCycle]
        .sort((a, b) => b.amountCents - a.amountCents || a.date.localeCompare(b.date))
        .slice(0, topN),
      byCategory: [...categoryTotals.entries()]
        .map(([category, v]) => ({ category, ...v }))
        .sort((a, b) => b.amountCents - a.amountCents),
    };
  });

  out.sort((a, b) => {
    // Fullest cards first — that's the "am I too filled" question. Cards with
    // no known limit fall to the back rather than sorting as 0%.
    const au = a.utilization ?? -1;
    const bu = b.utilization ?? -1;
    return bu - au || b.cycleSpendCents - a.cycleSpendCents;
  });

  const withLimit = out.filter((c) => c.creditLimitCents != null && c.creditLimitCents > 0);
  const totalLimitCents = withLimit.reduce((s, c) => s + (c.creditLimitCents ?? 0), 0);
  // Overall utilization only counts cards whose limit we know, so an unknown
  // limit can't silently deflate the ratio.
  const balanceOnLimited = withLimit.reduce((s, c) => s + Math.max(0, c.balanceCents ?? 0), 0);

  return {
    cards: out,
    totalCycleSpendCents: out.reduce((s, c) => s + c.cycleSpendCents, 0),
    totalBalanceCents: out.reduce((s, c) => s + Math.max(0, c.balanceCents ?? 0), 0),
    totalLimitCents,
    overallUtilization: totalLimitCents > 0 ? balanceOnLimited / totalLimitCents : null,
    cardsWithoutLimit: out.length - withLimit.length,
    crowded: out.filter((c) => c.band === "high" || c.band === "maxed"),
  };
}
