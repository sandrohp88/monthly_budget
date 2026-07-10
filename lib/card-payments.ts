/**
 * Credit-card cash-out projection.
 *
 * Everything a credit card contributes to the daily cash projection is a
 * *payment* (checking → card). The size and timing of those payments is
 * predicted from five sources, which this module folds into a single ordered
 * list of projection "extras":
 *
 *   1. Recorded statements  — unpaid statement cash on its due date.
 *   2. Open-cycle estimate  — live balance − unpaid − promo, on the next due
 *                             date, ONLY when that date has no recorded
 *                             statement (the statement is authoritative).
 *   3. Promo chunks         — 0% financing monthly chunks on future due dates
 *                             (skipping dates with a recorded statement).
 *   4. Variable spend       — forecast variable-bill charges landed on card
 *                             due dates.
 *   5. Planned payments     — per-(card,dueDate) overrides not already claimed
 *                             by 1–4.
 *
 * A per-(card,dueDate) override REPLACES the amount for whichever of 1–3 owns
 * that slot; variable spend (4) is additive and only marks the slot claimed so
 * a planned payment (5) doesn't also fire there.
 *
 * This is the single home for the "recorded statement is authoritative"
 * rule (CLAUDE.md §17a) — the skip-sets that used to be threaded through
 * projection-server live here now. Pure: no I/O, deterministic for its inputs,
 * unit-tested in card-payments.test.ts and guarded end-to-end by
 * projection-server.test.ts.
 */

import {
  dueDateFromStatement,
  nextStatementDateOnOrAfter,
  projectPromoScheduleWithBalances,
  statementCashDueCents,
} from "./credit-cards";
import { projectVariableBillCardCharges, type VariableBillWithCards } from "./variable-bills";
import type { OneTimeExpense } from "./projection";
import type {
  CreditCardPaymentOverrideRow,
  CreditCardPromoRow,
  CreditCardPromoPaymentRow,
  CreditCardRow,
  CreditCardStatementRow,
} from "./db/schema";

export type StatementWithCardName = CreditCardStatementRow & { cardName: string };

export type ProjectCardPaymentsInput = {
  today: string;
  endDate: string;
  activeCards: CreditCardRow[];
  statements: StatementWithCardName[];
  promos: CreditCardPromoRow[];
  promoPayments: CreditCardPromoPaymentRow[];
  variableBills: VariableBillWithCards[];
  /** Plaid account balances, for cards linked to a Plaid account. */
  plaidAccounts: Array<{ id: string; balanceCents: number | null }>;
  cardPaymentOverrides: CreditCardPaymentOverrideRow[];
};

export type ProjectCardPaymentsResult = {
  /** Card payment debits, ordered: statements, open-cycle, promo, variable, planned. */
  extras: OneTimeExpense[];
  /** Per-card promo principal that exceeded the live-balance headroom (see below). */
  promoDriftByCard: Record<string, number>;
  /** Variable-bill category names keyed by `cardId:dueDate` (for the UI). */
  variableBillCategoriesByKey: Record<string, string[]>;
};

const overrideKey = (cardId: string, dueDate: string) => `${cardId}:${dueDate}`;

function movedFromDate(notes: string | null | undefined): string | undefined {
  const match = notes?.match(/(?:^|\s)moved-from:(\d{4}-\d{2}-\d{2})(?:\s|$)/);
  return match?.[1];
}

export function projectCardPayments(input: ProjectCardPaymentsInput): ProjectCardPaymentsResult {
  const { today, endDate, activeCards, statements, promos, variableBills } = input;

  const cardById = new Map(activeCards.map((c) => [c.id, c] as const));

  const promoPaymentsByPromoId = new Map<
    string,
    Array<{ dueDate: string; amountCents: number }>
  >();
  for (const pp of input.promoPayments) {
    const list = promoPaymentsByPromoId.get(pp.promoId) ?? [];
    list.push({ dueDate: pp.dueDate, amountCents: pp.amountCents });
    promoPaymentsByPromoId.set(pp.promoId, list);
  }

  const cardOverridesByCard = new Map<string, Map<string, { amountCents: number; notes: string | null }>>();
  for (const override of input.cardPaymentOverrides) {
    let byDate = cardOverridesByCard.get(override.cardId);
    if (!byDate) {
      byDate = new Map<string, { amountCents: number; notes: string | null }>();
      cardOverridesByCard.set(override.cardId, byDate);
    }
    byDate.set(override.dueDate, { amountCents: override.amountCents, notes: override.notes });
  }
  const appliedCardOverrideKeys = new Set<string>();

  // Open-cycle estimate per Plaid-linked active card: the live card balance
  // minus any unpaid statements minus the unbilled promo principal is the
  // floor of what's been spent in the current open cycle, which will land on
  // the next statement and be due on the dueDate after that. Subtracting
  // unpaid statements avoids double-counting them (they become ccExtras).
  // Subtracting promo remaining avoids projecting unbilled promo principal as a
  // single lump on the next due date — promos contribute their own monthly
  // chunks via promoExtras below.
  const balanceByPlaidAccount = new Map(input.plaidAccounts.map((a) => [a.id, a.balanceCents] as const));
  const unpaidByCard = new Map<string, number>();
  // Treat any portion of a statement that's still owed as unpaid. A non-null
  // `paidAmountCents` only means a payment was applied — if it's smaller than
  // the statement balance, the carryover still needs to be projected as cash.
  for (const s of statements) {
    const unpaidPortion = Math.max(0, s.statementBalanceCents - (s.paidAmountCents ?? 0));
    if (unpaidPortion > 0) {
      unpaidByCard.set(s.cardId, (unpaidByCard.get(s.cardId) ?? 0) + unpaidPortion);
    }
  }
  const promoRemainingByCard = new Map<string, number>();
  for (const p of promos) {
    promoRemainingByCard.set(
      p.cardId,
      (promoRemainingByCard.get(p.cardId) ?? 0) + p.remainingAmountCents,
    );
  }
  const liveBalanceForCard = (cardId: string): number | null => {
    const card = cardById.get(cardId);
    if (!card) return null;
    if (card.plaidAccountId) {
      return balanceByPlaidAccount.get(card.plaidAccountId) ?? card.currentBalanceCents ?? null;
    }
    return card.currentBalanceCents ?? null;
  };
  const displayBalanceForCard = (cardId: string, fallbackDueCents: number): number => {
    const liveBalance = liveBalanceForCard(cardId);
    return Math.max(liveBalance ?? 0, fallbackDueCents, promoRemainingByCard.get(cardId) ?? 0);
  };

  // ── 1. Recorded statements ────────────────────────────────────────────────
  // Unpaid credit-card statements become extras on their due date so the
  // projection deducts them from the running balance. Paid statements are
  // already reflected in the starting balance and are skipped. These events
  // also carry card-balance metadata so a user can plan paying above the
  // statement due amount when a 0% promo balance is present.
  const statementDueByCardDate = new Map<
    string,
    { cardId: string; cardName: string; dueDate: string; remainingCents: number }
  >();
  for (const s of statements) {
    const dueCents = statementCashDueCents(s);
    const remainingCents = Math.max(0, dueCents - (s.paidAmountCents ?? 0));
    if (remainingCents <= 0) continue;
    const key = overrideKey(s.cardId, s.dueDate);
    const existing = statementDueByCardDate.get(key);
    if (!existing || remainingCents > existing.remainingCents) {
      statementDueByCardDate.set(key, {
        cardId: s.cardId,
        cardName: s.cardName,
        dueDate: s.dueDate,
        remainingCents,
      });
    }
  }
  const ccExtras: OneTimeExpense[] = [];
  for (const group of statementDueByCardDate.values()) {
    const override = cardOverridesByCard.get(group.cardId)?.get(group.dueDate);
    appliedCardOverrideKeys.add(overrideKey(group.cardId, group.dueDate));
    const amountCents = override?.amountCents ?? group.remainingCents;
    ccExtras.push({
      date: group.dueDate,
      description: `${group.cardName} payment`,
      amountCents,
      sourceId: group.cardId,
      sourceType: "creditCardPayment" as const,
      originalAmountCents: group.remainingCents,
      relatedDate: movedFromDate(override?.notes),
      paymentDueCents: group.remainingCents,
      paymentBalanceCents: displayBalanceForCard(group.cardId, group.remainingCents),
    });
  }

  // Due dates that already have a recorded statement. A recorded statement is
  // authoritative for the cash due that cycle (§17a), so the live-balance
  // open-cycle estimate and promo chunks both defer to it on that date.
  const recordedDueDatesByCard = new Map<string, Set<string>>();
  for (const s of statements) {
    let set = recordedDueDatesByCard.get(s.cardId);
    if (!set) {
      set = new Set();
      recordedDueDatesByCard.set(s.cardId, set);
    }
    set.add(s.dueDate);
  }

  // ── 2. Open-cycle estimate ────────────────────────────────────────────────
  const openCycleExtras: OneTimeExpense[] = [];
  const promoDriftByCard: Record<string, number> = {};
  for (const card of activeCards) {
    const liveBalance = card.plaidAccountId
      ? balanceByPlaidAccount.get(card.plaidAccountId)
      : card.currentBalanceCents;
    if (liveBalance == null || liveBalance <= 0) continue;
    const unpaid = unpaidByCard.get(card.id) ?? 0;
    // Promo records can drift higher than the issuer's actual unbilled promo
    // principal (especially on PayPal, where Plaid doesn't return per-payment
    // data so our auto-decrement edge rarely fires). Cap the subtraction at
    // what's actually owed minus unpaid statements, otherwise a $5k drifted
    // promo total would wipe out a $3k open-cycle estimate to $0. Record the
    // overflow so the UI can prompt the user to reconcile.
    const promoRemainingRaw = promoRemainingByCard.get(card.id) ?? 0;
    const headroom = Math.max(0, liveBalance - unpaid);
    const promoRemaining = Math.min(promoRemainingRaw, headroom);
    const drift = promoRemainingRaw - promoRemaining;
    if (drift > 0) promoDriftByCard[card.id] = drift;
    const openCycleCents = Math.max(0, liveBalance - unpaid - promoRemaining);
    if (openCycleCents <= 0) continue;
    const nextStatement = nextStatementDateOnOrAfter(today, card);
    const dueDate = dueDateFromStatement(nextStatement, card.dueDay, card.gracePeriodDays);
    // Prefer the recorded statement: if the cycle this estimate lands on
    // already has a recorded statement, that statement's cash is authoritative
    // for the date (it becomes a ccExtra). Layering the live-balance estimate
    // on top would double-count. Only estimate cycles with no recorded
    // statement — which also shrinks where the promo drift cap can fire.
    if (recordedDueDatesByCard.get(card.id)?.has(dueDate)) continue;
    const override = cardOverridesByCard.get(card.id)?.get(dueDate);
    appliedCardOverrideKeys.add(overrideKey(card.id, dueDate));
    const amountCents = override?.amountCents ?? openCycleCents;
    if (amountCents > 0) {
      openCycleExtras.push({
        date: dueDate,
        description: `${card.name} next payment (est)`,
        amountCents,
        sourceId: card.id,
        sourceType: "creditCardPayment",
        originalAmountCents: openCycleCents,
        relatedDate: movedFromDate(override?.notes),
        paymentDueCents: openCycleCents,
        paymentBalanceCents: Math.max(liveBalance, openCycleCents),
      });
    }
  }

  // ── 3. Promo chunks ───────────────────────────────────────────────────────
  // Each active promo contributes one debit per future cycle's due date through
  // its endDate. A recorded statement suppresses promo chunks for that due date
  // even when the statement due amount is $0: issuer statements are
  // authoritative for due balances, while optional paydowns should be modeled
  // as explicit planned card payments.
  const promoChunksByCardDate = new Map<
    string,
    {
      cardId: string;
      cardName: string;
      dueDate: string;
      amountCents: number;
      balanceCents: number;
      descriptions: string[];
    }
  >();
  for (const promo of promos) {
    const card = cardById.get(promo.cardId);
    if (!card) continue; // archived card → promo also pauses (promo monthly cash floats away)
    const skip = recordedDueDatesByCard.get(promo.cardId) ?? new Set<string>();
    const sched = promoPaymentsByPromoId.get(promo.id) ?? [];
    const schedule = projectPromoScheduleWithBalances(promo, card, today, skip, sched);
    for (const chunk of schedule) {
      const key = overrideKey(card.id, chunk.dueDate);
      const existing = promoChunksByCardDate.get(key);
      if (existing) {
        existing.amountCents += chunk.amountCents;
        existing.balanceCents += chunk.balanceBeforeCents;
        existing.descriptions.push(promo.description);
      } else {
        promoChunksByCardDate.set(key, {
          cardId: card.id,
          cardName: card.name,
          dueDate: chunk.dueDate,
          amountCents: chunk.amountCents,
          balanceCents: chunk.balanceBeforeCents,
          descriptions: [promo.description],
        });
      }
    }
  }
  const promoExtras: OneTimeExpense[] = [];
  for (const chunk of promoChunksByCardDate.values()) {
    const override = cardOverridesByCard.get(chunk.cardId)?.get(chunk.dueDate);
    appliedCardOverrideKeys.add(overrideKey(chunk.cardId, chunk.dueDate));
    const amountCents = override?.amountCents ?? chunk.amountCents;
    if (amountCents <= 0) continue;
    const descLabel = chunk.descriptions.join(", ");
    promoExtras.push({
      date: chunk.dueDate,
      description: `${chunk.cardName} promo (${descLabel})`,
      amountCents,
      sourceId: chunk.cardId,
      sourceType: "creditCardPayment",
      originalAmountCents: chunk.amountCents,
      relatedDate: movedFromDate(override?.notes),
      paymentDueCents: chunk.amountCents,
      paymentBalanceCents: chunk.balanceCents,
    });
  }

  // ── 4. Variable spend ─────────────────────────────────────────────────────
  const variableBillChargeGroups = new Map<
    string,
    { cardId: string; cardName: string; dueDate: string; amountCents: number; names: string[]; categories: string[] }
  >();
  const variableCharges = projectVariableBillCardCharges({
    variableBills,
    cards: activeCards,
    startDate: today,
    endDate,
  });
  for (const charge of variableCharges) {
    const card = cardById.get(charge.cardId);
    if (!card) continue;
    const key = overrideKey(charge.cardId, charge.dueDate);
    const existing = variableBillChargeGroups.get(key);
    if (existing) {
      existing.amountCents += charge.amountCents;
      if (!existing.names.includes(charge.name)) existing.names.push(charge.name);
      if (!existing.categories.includes(charge.category)) existing.categories.push(charge.category);
    } else {
      variableBillChargeGroups.set(key, {
        cardId: charge.cardId,
        cardName: card.name,
        dueDate: charge.dueDate,
        amountCents: charge.amountCents,
        names: [charge.name],
        categories: [charge.category],
      });
    }
  }
  const variableBillExtras: OneTimeExpense[] = [];
  for (const group of variableBillChargeGroups.values()) {
    if (group.amountCents <= 0) continue;
    appliedCardOverrideKeys.add(overrideKey(group.cardId, group.dueDate));
    variableBillExtras.push({
      date: group.dueDate,
      description: `${group.cardName} variable spend (${group.names.join(", ")})`,
      amountCents: group.amountCents,
      sourceId: group.cardId,
      sourceType: "creditCardPayment",
      originalAmountCents: group.amountCents,
      paymentDueCents: group.amountCents,
      paymentBalanceCents: displayBalanceForCard(group.cardId, group.amountCents),
    });
  }

  // ── 5. Planned payments ───────────────────────────────────────────────────
  const plannedCardExtras: OneTimeExpense[] = [];
  for (const [cardId, overrides] of cardOverridesByCard) {
    const card = cardById.get(cardId);
    if (!card) continue;
    for (const [dueDate, override] of overrides) {
      if (appliedCardOverrideKeys.has(overrideKey(cardId, dueDate))) continue;
      if (override.amountCents <= 0) continue;
      plannedCardExtras.push({
        date: dueDate,
        description: `${card.name} planned payment`,
        amountCents: override.amountCents,
        sourceId: cardId,
        sourceType: "creditCardPayment",
        originalAmountCents: 0,
        relatedDate: movedFromDate(override.notes),
        paymentDueCents: 0,
        paymentBalanceCents: displayBalanceForCard(cardId, 0),
      });
    }
  }

  const variableBillCategoriesByKey: Record<string, string[]> = {};
  for (const [key, group] of variableBillChargeGroups) {
    if (group.categories.length > 0) {
      variableBillCategoriesByKey[key] = group.categories;
    }
  }

  // Merge everything that lands on the same (card, due date) into a single
  // payment. Several sources can target one date — a statement plus variable
  // spend, or an open-cycle estimate plus a promo chunk. One combined row is
  // what actually leaves checking that day and reads far cleaner than three
  // separate "<Card> …" rows stacked on the same date. A lone source on a date
  // is emitted UNCHANGED (byte-identical), so recorded-statement behavior and
  // the golden projection tests are unaffected.
  const kindByEvent = new Map<OneTimeExpense, string>();
  for (const e of ccExtras) kindByEvent.set(e, "statement");
  for (const e of openCycleExtras) kindByEvent.set(e, "est. spend");
  for (const e of promoExtras) kindByEvent.set(e, "promo");
  for (const e of variableBillExtras) kindByEvent.set(e, "variable");
  for (const e of plannedCardExtras) kindByEvent.set(e, "planned");

  const extras = mergeByDueDate(
    [...ccExtras, ...openCycleExtras, ...promoExtras, ...variableBillExtras, ...plannedCardExtras],
    kindByEvent,
    cardById,
  );

  return { extras, promoDriftByCard, variableBillCategoriesByKey };
}

/**
 * Collapse card-payment events sharing a (cardId, date) into one row: amounts,
 * originals, and due totals sum; the shown card balance is the max; the label
 * lists the contributing kinds (e.g. "Card payment (statement + variable)").
 * Groups of one pass through untouched so single-source days are unchanged.
 * First-occurrence order is preserved.
 */
function mergeByDueDate(
  events: OneTimeExpense[],
  kindByEvent: ReadonlyMap<OneTimeExpense, string>,
  cardById: ReadonlyMap<string, CreditCardRow>,
): OneTimeExpense[] {
  const groups = new Map<string, OneTimeExpense[]>();
  const order: string[] = [];
  for (const e of events) {
    const key = `${e.sourceId}:${e.date}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      order.push(key);
    }
    group.push(e);
  }

  const out: OneTimeExpense[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    const first = group[0]!;
    if (group.length === 1) {
      out.push(first);
      continue;
    }
    const cardName = (first.sourceId ? cardById.get(first.sourceId)?.name : undefined) ?? "Card";
    const kinds = [...new Set(group.map((e) => kindByEvent.get(e) ?? "payment"))];
    out.push({
      ...first,
      description: `${cardName} payment (${kinds.join(" + ")})`,
      amountCents: group.reduce((s, e) => s + e.amountCents, 0),
      originalAmountCents: group.reduce((s, e) => s + (e.originalAmountCents ?? 0), 0),
      paymentDueCents: group.reduce((s, e) => s + (e.paymentDueCents ?? 0), 0),
      paymentBalanceCents: Math.max(...group.map((e) => e.paymentBalanceCents ?? 0)),
      relatedDate: group.map((e) => e.relatedDate).find(Boolean),
    });
  }
  return out;
}
