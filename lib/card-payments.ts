/**
 * Credit-card cash-out projection.
 *
 * The app no longer assumes you pay a card's full statement on its due date.
 * A card's obligation for a cycle — a recorded statement, or the estimated
 * open-cycle balance, or an estimated future cycle — is projected as a
 * zero-cash **due-date marker**: it shows what's owed, is colored by how much
 * of it you've scheduled a payment for, and warns that an uncovered balance
 * will accrue interest. It never debits checking.
 *
 * The ONLY things that move the running cash balance are:
 *
 *   • Payments you schedule (calendar PLAN / PROGRAM / drag) — a paydown, a
 *     plain planned payment, or a moved statement payment. These debit their
 *     own date and count as coverage toward the due marker(s) they land before.
 *   • Deferred-interest PROMO payoff chunks and card-charged variable spend —
 *     kept as projected cash-out (they're explicit payoff plans / forecast
 *     spend), unchanged from before.
 *
 * Markers vs. cash keep the projection honest: an unpaid statement no longer
 * silently drains cash, but the due date is never hidden and the interest risk
 * is surfaced.
 *
 * Pure: no I/O, deterministic for its inputs, unit-tested in
 * card-payments.test.ts and guarded end-to-end by projection-server.test.ts.
 */

import {
  dueDateFromStatement,
  interestSavingCashDueCents,
  nextStatementDateOnOrAfter,
  projectPromoScheduleWithBalances,
} from "./credit-cards";
import { addDaysIso } from "./dates";
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
  /**
   * Card projection events: zero-cash due-date markers (`dueMarker: true`) plus
   * cash-out payments (scheduled payments, promo chunks, variable spend).
   */
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

/**
 * Scheduled paydown marker: `pays-down:<dueDate>` in an override's notes means
 * "this planned payment reduces whatever the projection charges on that card
 * due date" — statement, open-cycle estimate, or promo chunk. Written by the
 * calendar's PLAN CARD PAYMENT flow.
 */
export function paydownTargetDate(notes: string | null | undefined): string | undefined {
  const match = notes?.match(/(?:^|\s)pays-down:(\d{4}-\d{2}-\d{2})(?:\s|$)/);
  return match?.[1];
}

export type CardPaymentMoveInput = {
  /** The date the payment currently sits on. */
  fromDate: string;
  /** True when this is a scheduled paydown (a `pays-down:` override). */
  isPaydown: boolean;
  /**
   * Cash still due at this slot from a statement / open-cycle estimate / promo
   * chunk. 0 for a plain planned payment or a paydown, which carry no issuer
   * deadline of their own.
   */
  paymentDueCents: number;
  /** For an already-moved payment, the original issuer due date. */
  relatedDate?: string;
};

/**
 * Validate dragging a card payment from its current day to `toDate`. Returns
 * null when the move is allowed, or a human-readable reason it isn't. The rules
 * mirror the calendar dialogs (CardPaymentPlanDialog / ScheduleCardPaymentDialog):
 *
 *   - Never move a payment into the past.
 *   - A statement / open-cycle-estimate / promo due (`paymentDueCents > 0`) may
 *     only move EARLIER — never after the issuer due date, because paying after
 *     it defeats the "avoid interest" purpose. The issuer due date is the date
 *     the payment was moved from (`relatedDate`) if already moved, else
 *     `fromDate`.
 *   - A scheduled paydown or a plain planned payment can move to any future day.
 *
 * `toDate === fromDate` is a no-op the caller should skip; it validates as null.
 */
export function cardPaymentMoveError(
  input: CardPaymentMoveInput,
  toDate: string,
  today: string,
): string | null {
  if (toDate < today) return "Choose today or a future date.";
  if (input.isPaydown || input.paymentDueCents <= 0) return null;
  const dueDate = input.relatedDate ?? input.fromDate;
  if (toDate > dueDate) {
    return `Move earlier — a card payment can't be scheduled after its due date ${dueDate}.`;
  }
  return null;
}

/** A scheduled cash payment parsed from an override (plain or moved). */
type ScheduledPayment = {
  cardId: string;
  date: string;
  amountCents: number;
  /** The due date this payment is directed at (moved-from date, else its own). */
  targetDueDate: string;
  /** Original issuer due date when the payment was moved off it. */
  relatedDate?: string;
};

/** A card obligation for one cycle — rendered as a zero-cash due marker. */
type DueMarker = {
  cardId: string;
  cardName: string;
  dueDate: string;
  owedCents: number;
  balanceCents: number;
  estimated: boolean;
};

export function projectCardPayments(input: ProjectCardPaymentsInput): ProjectCardPaymentsResult {
  const { today, endDate, activeCards, statements, promos, variableBills } = input;

  const cardById = new Map(activeCards.map((c) => [c.id, c] as const));
  const balanceByPlaidAccount = new Map(
    input.plaidAccounts.map((a) => [a.id, a.balanceCents] as const),
  );

  const promoPaymentsByPromoId = new Map<
    string,
    Array<{ dueDate: string; amountCents: number }>
  >();
  for (const pp of input.promoPayments) {
    const list = promoPaymentsByPromoId.get(pp.promoId) ?? [];
    list.push({ dueDate: pp.dueDate, amountCents: pp.amountCents });
    promoPaymentsByPromoId.set(pp.promoId, list);
  }

  // Treat any portion of a statement still owed as unpaid.
  const unpaidByCard = new Map<string, number>();
  for (const s of statements) {
    const unpaidPortion = Math.max(0, s.statementBalanceCents - (s.paidAmountCents ?? 0));
    if (unpaidPortion > 0) {
      unpaidByCard.set(s.cardId, (unpaidByCard.get(s.cardId) ?? 0) + unpaidPortion);
    }
  }
  const promoRemainingByCard = new Map<string, number>();
  const promosByCard = new Map<string, CreditCardPromoRow[]>();
  for (const p of promos) {
    promoRemainingByCard.set(
      p.cardId,
      (promoRemainingByCard.get(p.cardId) ?? 0) + p.remainingAmountCents,
    );
    const list = promosByCard.get(p.cardId) ?? [];
    list.push(p);
    promosByCard.set(p.cardId, list);
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

  // ── Parse overrides → paydowns + plain/moved overrides ────────────────────
  // A `pays-down:` override is a paydown. Any other positive override is a
  // candidate scheduled payment — UNLESS it sits on a promo/variable cash
  // chunk's date, in which case it REPLACES that chunk's amount (the classic
  // "edit this promo/variable payment" path). Statement/estimate dates carry no
  // cash, so overrides there are always scheduled payments.
  const paydowns: Array<{ cardId: string; date: string; amountCents: number; targetDate: string }> =
    [];
  const nonPaydownOverrides: Array<{
    cardId: string;
    date: string;
    amountCents: number;
    movedFrom?: string;
  }> = [];
  for (const o of input.cardPaymentOverrides) {
    const target = paydownTargetDate(o.notes);
    if (target) {
      paydowns.push({
        cardId: o.cardId,
        date: o.dueDate,
        amountCents: o.amountCents,
        targetDate: target,
      });
      continue;
    }
    // `moved-to:` rows are zero-amount vacate markers — the real payment is the
    // matching `moved-from:` row. Skip anything with no cash.
    if (o.amountCents <= 0) continue;
    nonPaydownOverrides.push({
      cardId: o.cardId,
      date: o.dueDate,
      amountCents: o.amountCents,
      movedFrom: movedFromDate(o.notes),
    });
  }
  const overrideByKey = new Map<string, number>();
  for (const o of nonPaydownOverrides) overrideByKey.set(overrideKey(o.cardId, o.date), o.amountCents);
  const claimedOverrideKeys = new Set<string>();

  // ── Promo chunks (cash, unchanged) ────────────────────────────────────────
  const recordedDueDatesByCard = new Map<string, Set<string>>();
  for (const s of statements) {
    let set = recordedDueDatesByCard.get(s.cardId);
    if (!set) {
      set = new Set();
      recordedDueDatesByCard.set(s.cardId, set);
    }
    set.add(s.dueDate);
  }
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
    if (!card) continue;
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

  // ── Variable spend (cash, unchanged) ──────────────────────────────────────
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

  // A paydown targeting a promo/variable cash date reduces that cash chunk. One
  // targeting a statement/estimate marker date is display coverage only (the
  // marker has no cash). Classify accordingly.
  const cashChargeKeys = new Set<string>([
    ...promoChunksByCardDate.keys(),
    ...variableBillChargeGroups.keys(),
  ]);
  const promoPaydownRemainingByKey = new Map<string, number>();
  const explicitPaydownCoverByKey = new Map<string, number>();
  const prepayPoolByCard = new Map<string, number>();
  for (const p of paydowns) {
    if (p.date < today || p.amountCents <= 0) continue;
    const key = overrideKey(p.cardId, p.targetDate);
    // A paydown always counts as coverage toward a due marker on its target
    // date (display only — the marker has no cash of its own).
    explicitPaydownCoverByKey.set(key, (explicitPaydownCoverByKey.get(key) ?? 0) + p.amountCents);
    // If that date ALSO carries promo/variable cash, the paydown reduces it too
    // so the same money isn't projected twice.
    if (cashChargeKeys.has(key)) {
      promoPaydownRemainingByKey.set(key, (promoPaydownRemainingByKey.get(key) ?? 0) + p.amountCents);
    }
  }
  // Several generators can share one (card, date); consume from a shared pool so
  // a paydown is subtracted from the date's combined total exactly once.
  const consumeAtChunk = (cardId: string, dueDate: string, baseCents: number): number => {
    if (baseCents <= 0) return 0;
    const key = overrideKey(cardId, dueDate);
    const remaining = promoPaydownRemainingByKey.get(key) ?? 0;
    if (remaining <= 0) return 0;
    const consumed = Math.min(baseCents, remaining);
    promoPaydownRemainingByKey.set(key, remaining - consumed);
    return consumed;
  };

  const promoExtras: OneTimeExpense[] = [];
  for (const chunk of promoChunksByCardDate.values()) {
    const key = overrideKey(chunk.cardId, chunk.dueDate);
    // An override sitting on the chunk's date replaces its amount ("edit this
    // promo payment") and is consumed here rather than becoming a separate cash
    // payment that would double-count.
    const override = overrideByKey.get(key);
    if (override != null) claimedOverrideKeys.add(key);
    const baseCents = override ?? chunk.amountCents;
    const consumed = consumeAtChunk(chunk.cardId, chunk.dueDate, baseCents);
    const amountCents = baseCents - consumed;
    if (amountCents <= 0) continue;
    promoExtras.push({
      date: chunk.dueDate,
      description: `${chunk.cardName} promo (${chunk.descriptions.join(", ")})`,
      amountCents,
      sourceId: chunk.cardId,
      sourceType: "creditCardPayment",
      originalAmountCents: chunk.amountCents,
      paymentDueCents: Math.max(0, chunk.amountCents - consumed),
      paymentBalanceCents: chunk.balanceCents,
    });
  }
  const variableBillExtras: OneTimeExpense[] = [];
  for (const group of variableBillChargeGroups.values()) {
    const key = overrideKey(group.cardId, group.dueDate);
    const override = overrideByKey.get(key);
    if (override != null) claimedOverrideKeys.add(key);
    const baseCents = override ?? group.amountCents;
    const consumed = consumeAtChunk(group.cardId, group.dueDate, baseCents);
    const amountCents = baseCents - consumed;
    if (amountCents <= 0) continue;
    variableBillExtras.push({
      date: group.dueDate,
      description: `${group.cardName} variable spend (${group.names.join(", ")})`,
      amountCents,
      sourceId: group.cardId,
      sourceType: "creditCardPayment",
      originalAmountCents: group.amountCents,
      paymentDueCents: amountCents,
      paymentBalanceCents: displayBalanceForCard(group.cardId, group.amountCents),
    });
  }

  // Overrides not claimed by a promo/variable chunk are scheduled cash payments:
  // they debit their own date and count as coverage toward the due markers they
  // land on/before.
  const scheduledPayments: ScheduledPayment[] = [];
  for (const o of nonPaydownOverrides) {
    if (claimedOverrideKeys.has(overrideKey(o.cardId, o.date))) continue;
    scheduledPayments.push({
      cardId: o.cardId,
      date: o.date,
      amountCents: o.amountCents,
      targetDueDate: o.movedFrom ?? o.date,
      relatedDate: o.movedFrom,
    });
  }
  // A paydown planned larger than its target promo/variable chunk: the excess
  // knocks down that card's other promo chunks, soonest first.
  for (const [key, remaining] of promoPaydownRemainingByKey) {
    if (remaining <= 0) continue;
    const cardId = key.slice(0, key.lastIndexOf(":"));
    prepayPoolByCard.set(cardId, (prepayPoolByCard.get(cardId) ?? 0) + remaining);
  }

  // ── Due-date markers (zero cash) ──────────────────────────────────────────
  // One per cycle per active card, from today through the projection window:
  // recorded statement when known, open-cycle estimate for the current cycle,
  // carried-forward estimate for future cycles. Never debits checking.
  const promoDriftByCard: Record<string, number> = {};
  const markers: DueMarker[] = [];
  const markerKeys = new Set<string>();
  const pushMarker = (m: DueMarker) => {
    const key = overrideKey(m.cardId, m.dueDate);
    if (markerKeys.has(key)) return;
    markerKeys.add(key);
    markers.push(m);
  };

  // 1. Recorded statements due today or later. The owed amount is the
  // Interest Saving Balance, not the full statement balance: outstanding 0%
  // promo principal isn't exposed to interest and its future chunks are
  // already projected as promo cash on later due dates — marking the full
  // balance here would both overstate the interest risk and double-represent
  // the promo principal.
  for (const s of statements) {
    if (s.dueDate < today) continue;
    const isbDue = interestSavingCashDueCents(s, promosByCard.get(s.cardId) ?? []);
    const owed = Math.max(0, isbDue - (s.paidAmountCents ?? 0));
    if (owed <= 0) continue;
    pushMarker({
      cardId: s.cardId,
      cardName: s.cardName,
      dueDate: s.dueDate,
      owedCents: owed,
      balanceCents: displayBalanceForCard(s.cardId, owed),
      estimated: false,
    });
  }

  // 2 + 3. Open-cycle estimate (this cycle) and carried-forward future cycles.
  for (const card of activeCards) {
    const liveBalance = card.plaidAccountId
      ? balanceByPlaidAccount.get(card.plaidAccountId)
      : card.currentBalanceCents;
    let recurringEstimate = 0;
    if (liveBalance != null && liveBalance > 0) {
      const unpaidRaw = unpaidByCard.get(card.id) ?? 0;
      const promoRemainingRaw = promoRemainingByCard.get(card.id) ?? 0;
      // A Chase-style statement balance contains the card's outstanding promo
      // principal (§17a). Since promoRemaining is subtracted on its own below,
      // remove it from the unpaid-statement total first — otherwise the same
      // principal is subtracted twice and a promo-heavy card's estimate
      // collapses to $0 with a phantom "drift". Only when the unpaid total can
      // actually contain the principal (unpaid ≥ remaining) — a smaller total
      // is the PayPal shape, where statements bill only the cycle's cash.
      const unpaid =
        unpaidRaw >= promoRemainingRaw ? unpaidRaw - promoRemainingRaw : unpaidRaw;
      // Cap the promo subtraction at the live-balance headroom so a drifted
      // promo total can't wipe the estimate to $0; record the overflow.
      const headroom = Math.max(0, liveBalance - unpaid);
      const promoRemaining = Math.min(promoRemainingRaw, headroom);
      const drift = promoRemainingRaw - promoRemaining;
      if (drift > 0) promoDriftByCard[card.id] = drift;
      recurringEstimate = Math.max(0, liveBalance - unpaid - promoRemaining);
    }
    if (recurringEstimate <= 0) continue;

    // Walk the card's statement cycles from the next close through endDate.
    let statementDate = nextStatementDateOnOrAfter(today, card);
    let guard = 0;
    while (guard++ < 240) {
      const dueDate = dueDateFromStatement(statementDate, card.dueDay, card.gracePeriodDays);
      if (dueDate > endDate) break;
      if (dueDate >= today && !recordedDueDatesByCard.get(card.id)?.has(dueDate)) {
        pushMarker({
          cardId: card.id,
          cardName: card.name,
          dueDate,
          owedCents: recurringEstimate,
          balanceCents: Math.max(liveBalance ?? 0, recurringEstimate),
          estimated: true,
        });
      }
      const nextStatementDate = nextStatementDateOnOrAfter(addDaysIso(statementDate, 1), card);
      if (nextStatementDate <= statementDate) break; // safety: no forward progress
      statementDate = nextStatementDate;
    }
  }

  // ── Coverage: which markers your scheduled payments cover ─────────────────
  // Two kinds of obligation behave differently:
  //   • A recorded statement is a distinct per-cycle bill — a payment covers
  //     that one statement (consumed, earliest-due first).
  //   • Estimated cycles all share ONE running card balance. A payment paid down
  //     against it reduces THIS cycle AND every later cycle — otherwise a paydown
  //     shown clearing August's estimate would let September snap back to the
  //     full balance. So estimate coverage is cumulative by cash date, not
  //     consumed per cycle.
  // Leftover cash beyond statements + the estimate balance credits promo chunks.
  markers.sort((a, b) =>
    a.cardId === b.cardId ? a.dueDate.localeCompare(b.dueDate) : a.cardId.localeCompare(b.cardId),
  );
  const paymentsByCard = new Map<string, Array<{ date: string; remaining: number }>>();
  for (const s of scheduledPayments) {
    if (s.amountCents <= 0) continue;
    const list = paymentsByCard.get(s.cardId) ?? [];
    list.push({ date: s.date, remaining: s.amountCents });
    paymentsByCard.set(s.cardId, list);
  }

  const estimatedDuesByCard = new Map<string, Set<string>>();
  const markersByCard = new Map<string, DueMarker[]>();
  for (const m of markers) {
    const list = markersByCard.get(m.cardId) ?? [];
    list.push(m);
    markersByCard.set(m.cardId, list);
    if (m.estimated) {
      const set = estimatedDuesByCard.get(m.cardId) ?? new Set<string>();
      set.add(m.dueDate);
      estimatedDuesByCard.set(m.cardId, set);
    }
  }

  // A paydown keeps its directed semantics only while `pays-down:<date>` still
  // resolves to something on that card: a promo/variable cash chunk, a recorded
  // statement's marker, or an estimated cycle due. Statement reconciliation and
  // cycle-config edits shift every projected due date after the note is
  // written, so a stored target can go stale — and directed cash aimed at a
  // slot that no longer exists used to count as coverage NOWHERE, leaving the
  // real due marker warning about interest days after a scheduled payment.
  // Unmatched targets fall back to plain scheduled-payment coverage:
  // statements earliest-first, then the estimate balance, then promo prepay.
  const statementMarkerKeys = new Set<string>();
  for (const m of markers) {
    if (!m.estimated) statementMarkerKeys.add(overrideKey(m.cardId, m.dueDate));
  }
  for (const p of paydowns) {
    if (p.date < today || p.amountCents <= 0) continue;
    const targetKey = overrideKey(p.cardId, p.targetDate);
    if (
      cashChargeKeys.has(targetKey) ||
      statementMarkerKeys.has(targetKey) ||
      estimatedDuesByCard.get(p.cardId)?.has(p.targetDate)
    ) {
      continue;
    }
    const list = paymentsByCard.get(p.cardId) ?? [];
    list.push({ date: p.date, remaining: p.amountCents });
    paymentsByCard.set(p.cardId, list);
  }
  for (const list of paymentsByCard.values()) list.sort((a, b) => a.date.localeCompare(b.date));

  const coverByMarker = new Map<DueMarker, number>();
  for (const [cardId, cardMarkers] of markersByCard) {
    const pool = paymentsByCard.get(cardId) ?? [];
    const statementMarkers = cardMarkers.filter((m) => !m.estimated);
    const estimateMarkers = cardMarkers.filter((m) => m.estimated);

    // 1. Recorded statements: explicit paydown + plain payments, earliest first.
    for (const sm of statementMarkers) {
      let cover = explicitPaydownCoverByKey.get(overrideKey(cardId, sm.dueDate)) ?? 0;
      for (const p of pool) {
        if (cover >= sm.owedCents) break;
        if (p.remaining <= 0 || p.date > sm.dueDate) continue;
        const take = Math.min(p.remaining, sm.owedCents - cover);
        cover += take;
        p.remaining -= take;
      }
      coverByMarker.set(sm, Math.min(cover, sm.owedCents));
    }

    // 2. Estimated cycles share one running balance (recurringEstimate). Cash
    // paid down against it — plain payments left after statements, plus paydowns
    // aimed at an estimated due date — reduces every cycle on/after the cash date.
    if (estimateMarkers.length > 0) {
      const estBalance = estimateMarkers[0]!.owedCents;
      const estCash: Array<{ date: string; amt: number }> = [];
      for (const p of pool) if (p.remaining > 0) estCash.push({ date: p.date, amt: p.remaining });
      const estDues = estimatedDuesByCard.get(cardId);
      for (const pd of paydowns) {
        if (pd.cardId !== cardId || pd.amountCents <= 0 || pd.date < today) continue;
        if (estDues?.has(pd.targetDate)) estCash.push({ date: pd.date, amt: pd.amountCents });
      }
      for (const em of estimateMarkers) {
        let cumulative = 0;
        for (const c of estCash) if (c.date <= em.dueDate) cumulative += c.amt;
        coverByMarker.set(em, Math.min(estBalance, cumulative));
      }
      // Plain cash beyond what the estimate can absorb credits promo chunks.
      const plainLeftover = pool.reduce((s, p) => s + Math.max(0, p.remaining), 0);
      prepayPoolByCard.set(
        cardId,
        (prepayPoolByCard.get(cardId) ?? 0) + Math.max(0, plainLeftover - estBalance),
      );
    } else {
      const leftover = pool.reduce((s, p) => s + Math.max(0, p.remaining), 0);
      if (leftover > 0) prepayPoolByCard.set(cardId, (prepayPoolByCard.get(cardId) ?? 0) + leftover);
    }
  }
  // Cards with scheduled payments but no markers at all: their cash credits promo.
  for (const [cardId, pool] of paymentsByCard) {
    if (markersByCard.has(cardId)) continue;
    const leftover = pool.reduce((s, p) => s + Math.max(0, p.remaining), 0);
    if (leftover > 0) prepayPoolByCard.set(cardId, (prepayPoolByCard.get(cardId) ?? 0) + leftover);
  }

  // Apply the promo prepayment pool (paydown excess + scheduled surplus) to each
  // card's promo chunks, soonest first. Fully-covered chunks drop out.
  if (prepayPoolByCard.size > 0) {
    const promoByCard = promoExtras
      .filter((e) => e.sourceId != null && prepayPoolByCard.has(e.sourceId))
      .sort((a, b) =>
        a.sourceId === b.sourceId
          ? a.date.localeCompare(b.date)
          : a.sourceId!.localeCompare(b.sourceId!),
      );
    for (const e of promoByCard) {
      const pool = prepayPoolByCard.get(e.sourceId!) ?? 0;
      if (pool <= 0 || e.amountCents <= 0) continue;
      const credit = Math.min(pool, e.amountCents);
      e.amountCents -= credit;
      e.paymentDueCents = Math.max(0, (e.paymentDueCents ?? 0) - credit);
      prepayPoolByCard.set(e.sourceId!, pool - credit);
    }
  }
  const promoCashExtras = promoExtras.filter((e) => e.amountCents > 0);

  const markerExtras: OneTimeExpense[] = markers.map((m) => {
    const cover = Math.min(coverByMarker.get(m) ?? 0, m.owedCents);
    return {
      date: m.dueDate,
      description: m.estimated ? `${m.cardName} (est.)` : m.cardName,
      amountCents: 0,
      sourceId: m.cardId,
      sourceType: "creditCardPayment" as const,
      originalAmountCents: m.owedCents,
      paymentDueCents: m.owedCents,
      paymentBalanceCents: m.balanceCents,
      dueMarker: true,
      scheduledCoverCents: cover,
      estimated: m.estimated,
    };
  });

  // ── Scheduled payments → cash-out on their own dates ──────────────────────
  const plannedCardExtras: OneTimeExpense[] = [];
  for (const s of scheduledPayments) {
    const card = cardById.get(s.cardId);
    if (!card) continue;
    plannedCardExtras.push({
      date: s.date,
      description: `${card.name} planned payment`,
      amountCents: s.amountCents,
      sourceId: s.cardId,
      sourceType: "creditCardPayment",
      originalAmountCents: 0,
      relatedDate: s.relatedDate,
      paymentDueCents: 0,
      paymentBalanceCents: displayBalanceForCard(s.cardId, 0),
      userScheduled: true,
    });
  }
  for (const p of paydowns) {
    const card = cardById.get(p.cardId);
    if (!card || p.amountCents <= 0) continue;
    plannedCardExtras.push({
      date: p.date,
      description: `${card.name} planned payment`,
      amountCents: p.amountCents,
      sourceId: p.cardId,
      sourceType: "creditCardPayment",
      originalAmountCents: 0,
      paymentDueCents: 0,
      paymentBalanceCents: displayBalanceForCard(p.cardId, 0),
      paydownTargetDate: p.targetDate,
      userScheduled: true,
    });
  }

  const variableBillCategoriesByKey: Record<string, string[]> = {};
  for (const [key, group] of variableBillChargeGroups) {
    if (group.categories.length > 0) {
      variableBillCategoriesByKey[key] = group.categories;
    }
  }

  // Merge cash-out events (promo + variable + planned) that share a (card, date)
  // into one payment. Markers stay separate — a "$X owed" due date and a "$Y
  // paid" payment are different things even when they land on the same day.
  const kindByEvent = new Map<OneTimeExpense, string>();
  for (const e of promoCashExtras) kindByEvent.set(e, "promo");
  for (const e of variableBillExtras) kindByEvent.set(e, "variable");
  for (const e of plannedCardExtras) kindByEvent.set(e, "planned");
  const cashExtras = mergeByDueDate(
    [...promoCashExtras, ...variableBillExtras, ...plannedCardExtras],
    kindByEvent,
    cardById,
  );

  return {
    extras: [...markerExtras, ...cashExtras],
    promoDriftByCard,
    variableBillCategoriesByKey,
  };
}

/**
 * Collapse card cash-out events sharing a (cardId, date) into one row: amounts,
 * originals, and due totals sum; the shown card balance is the max; the label
 * lists the contributing kinds (e.g. "Card payment (promo + planned)").
 * Groups of one pass through untouched. First-occurrence order is preserved.
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
      // A merged row containing any user-planned cash keeps the plan's
      // settle-pivot semantics (a plan isn't in the live balance until posted).
      userScheduled: group.some((e) => e.userScheduled) || undefined,
    });
  }
  return out;
}
