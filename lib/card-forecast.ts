/**
 * Monthly credit-card obligation forecast.
 *
 * Answers "how much are my cards accumulating over the coming months" by
 * bucketing the projection's credit-card events into calendar months, per card.
 *
 * Pure, and deliberately derivative: it only reshapes what
 * `projectCardPayments` already decided (see lib/card-payments.ts), so the
 * forecast can never disagree with the ledger or the calendar.
 *
 * Three obligation kinds are kept apart because they carry very different
 * confidence:
 *
 *   • `statement` — a recorded issuer statement's Interest Saving Balance.
 *     A hard number.
 *   • `estimated` — a carried-forward open-cycle estimate. By design this is a
 *     RUN RATE: card-payments.ts repeats the same estimate on every future
 *     cycle, so summing it across months reads as "what cards will cost per
 *     month if spending continues", not as compounding debt.
 *   • `promo` — 0%/deferred-interest payoff chunks plus forecast variable card
 *     spend. Real scheduled cash with a deadline.
 *
 * `coveredCents` is cash already scheduled against those obligations;
 * `cashOutCents` is what actually leaves checking that month for cards
 * (planned payments + promo/variable chunks). Due markers never move cash, so
 * they contribute to `dueCents` only.
 */

import type { ProjectionRow } from "./projection";

export type CardForecastTotals = {
  /** Recorded statements due in this bucket. */
  statementDueCents: number;
  /** Carried-forward open-cycle estimates (run rate, not compounding debt). */
  estimatedDueCents: number;
  /** Promo payoff chunks + forecast variable card spend. */
  promoDueCents: number;
  /** statement + estimated + promo. */
  dueCents: number;
  /** Of `dueCents`, how much is already covered by scheduled cash. */
  coveredCents: number;
  /** Cash leaving checking for this card in this bucket. */
  cashOutCents: number;
};

export type CardForecastMonth = CardForecastTotals & {
  /** Bucket key, "YYYY-MM". */
  month: string;
  /** Same totals split by card id. Only cards with activity appear. */
  byCardId: Record<string, CardForecastTotals>;
};

export type CardForecastCard = CardForecastTotals & {
  cardId: string;
  cardName: string;
};

export type CardForecast = {
  months: CardForecastMonth[];
  /** Per-card totals across the whole window, biggest obligation first. */
  cards: CardForecastCard[];
  total: CardForecastTotals;
  /** First day covered (today — the current month bucket is partial). */
  fromDate: string;
  /** Last month bucket, "YYYY-MM". */
  throughMonth: string;
};

function emptyTotals(): CardForecastTotals {
  return {
    statementDueCents: 0,
    estimatedDueCents: 0,
    promoDueCents: 0,
    dueCents: 0,
    coveredCents: 0,
    cashOutCents: 0,
  };
}

function add(target: CardForecastTotals, delta: Partial<CardForecastTotals>): void {
  target.statementDueCents += delta.statementDueCents ?? 0;
  target.estimatedDueCents += delta.estimatedDueCents ?? 0;
  target.promoDueCents += delta.promoDueCents ?? 0;
  target.dueCents += delta.dueCents ?? 0;
  target.coveredCents += delta.coveredCents ?? 0;
  target.cashOutCents += delta.cashOutCents ?? 0;
}

/** `months` buckets starting at the month containing `fromIso`. */
function monthKeys(fromIso: string, months: number): string[] {
  const year = Number(fromIso.slice(0, 4));
  const month = Number(fromIso.slice(5, 7));
  const keys: string[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(year, month - 1 + i, 1));
    keys.push(d.toISOString().slice(0, 7));
  }
  return keys;
}

export type BuildCardForecastInput = {
  /** Projection rows (may include lookback days — anything before `today` is ignored). */
  rows: ProjectionRow[];
  today: string;
  /** Card id → display name, for the per-card rollup. */
  cardNames: ReadonlyMap<string, string>;
  /**
   * How many month buckets to emit, starting with the (partial) current month.
   * Defaults to 6. Keep this at or below the projection's own month count: the
   * projection window overshoots by a few days, so the bucket after it would be
   * truncated mid-month and silently understate that month.
   */
  months?: number;
};

export function buildCardForecast(input: BuildCardForecastInput): CardForecast {
  const { rows, today, cardNames } = input;
  const months = Math.max(1, input.months ?? 6);
  const keys = monthKeys(today, months);
  const lastMonth = keys[keys.length - 1]!;

  const buckets = new Map<string, CardForecastMonth>(
    keys.map((month) => [month, { month, byCardId: {}, ...emptyTotals() }]),
  );
  const cardTotals = new Map<string, CardForecastTotals>();
  const total = emptyTotals();

  for (const row of rows) {
    if (row.date < today) continue;
    const month = row.date.slice(0, 7);
    if (month > lastMonth) continue;
    const bucket = buckets.get(month);
    if (!bucket) continue;

    for (const event of row.events) {
      if (event.sourceType !== "creditCardPayment" || !event.sourceId) continue;
      const cardId = event.sourceId;
      const due = Math.max(0, event.paymentDueCents ?? 0);

      let delta: Partial<CardForecastTotals>;
      if (event.dueMarker) {
        // Zero-cash obligation marker: a recorded statement or an estimated cycle.
        const covered = Math.min(due, Math.max(0, event.scheduledCoverCents ?? 0));
        delta = event.estimated
          ? { estimatedDueCents: due, dueCents: due, coveredCents: covered }
          : { statementDueCents: due, dueCents: due, coveredCents: covered };
      } else {
        // Cash out: promo/variable chunks (which carry their own due) merged
        // with any planned payment on the same day (which carries due 0 — its
        // coverage is credited to the marker it targets, not counted twice here).
        const cash = Math.max(0, event.amountCents);
        delta = {
          promoDueCents: due,
          dueCents: due,
          coveredCents: Math.min(due, cash),
          cashOutCents: cash,
        };
      }

      const cell = (bucket.byCardId[cardId] ??= emptyTotals());
      add(cell, delta);
      add(bucket, delta);
      let cardTotal = cardTotals.get(cardId);
      if (!cardTotal) {
        cardTotal = emptyTotals();
        cardTotals.set(cardId, cardTotal);
      }
      add(cardTotal, delta);
      add(total, delta);
    }
  }

  const cards: CardForecastCard[] = [...cardTotals.entries()]
    .map(([cardId, totals]) => ({
      cardId,
      cardName: cardNames.get(cardId) ?? "Card",
      ...totals,
    }))
    .sort((a, b) => b.dueCents - a.dueCents || a.cardName.localeCompare(b.cardName));

  return {
    months: keys.map((k) => buckets.get(k)!),
    cards,
    total,
    fromDate: today,
    throughMonth: lastMonth,
  };
}
