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
 * Due dates are never mandatory: a payment may be scheduled on any day —
 * including AFTER the issuer due date (paying late on purpose is the user's
 * call; the marker keeps carrying the interest note). An unpaid statement
 * whose due date has already passed doesn't disappear either — it surfaces as
 * an OVERDUE marker on today (same convention as expired promos) that
 * scheduled payments can still be aimed at.
 *
 * Pure: no I/O, deterministic for its inputs, unit-tested in
 * card-payments.test.ts and guarded end-to-end by projection-server.test.ts.
 */

import {
  dueDateFromStatement,
  interestSavingCashDueCents,
  nextDayOfMonthOnOrAfter,
  nextStatementDateOnOrAfter,
  previousStatementDateOnOrBefore,
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
  /** Linked mode: remaining cash after posted checking payments. Past plans
   * stay effective while they are still reserved, including promo prepayment. */
  remainingPlannedCentsByKey?: ReadonlyMap<string, number>;
  /**
   * ISO date (user's timezone) of each card's last edit (`credit_cards.updated_at`,
   * converted by the caller; editing the balance bumps it). A manual card's
   * balance does not move when the user pays, so a past payment still covers
   * the closed-cycle estimate while the card was not edited on/after its date.
   * Missing → no past payment counts (fails toward showing the due).
   */
  cardEditedOnByCard?: ReadonlyMap<string, string>;
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
  /**
   * Per-card promo cash this projection still debits through `endDate`, after
   * paydowns, plan prepayment and skips (cards with none are absent). Chunks run
   * to the promo deadline, but computeProjection drops events after `endDate`,
   * so the window bound keeps this equal to what the calendar shows. The card
   * page's promo planner reads it so its text can never disagree with the calendar.
   */
  promoCashByCard: Record<string, number>;
};

const overrideKey = (cardId: string, dueDate: string) => `${cardId}:${dueDate}`;

/** One grammar for all note markers: `<tag>:<iso-date>` on its own word boundary. */
function noteTagDate(notes: string | null | undefined, tag: string): string | undefined {
  const match = notes?.match(new RegExp(`(?:^|\\s)${tag}:(\\d{4}-\\d{2}-\\d{2})(?:\\s|$)`));
  return match?.[1];
}

function movedFromDate(notes: string | null | undefined): string | undefined {
  return noteTagDate(notes, "moved-from");
}

function isMovedToVacate(notes: string | null | undefined): boolean {
  return noteTagDate(notes, "moved-to") != null;
}

/**
 * Scheduled paydown marker: `pays-down:<dueDate>` in an override's notes means
 * "this planned payment reduces whatever the projection charges on that card
 * due date" — statement, open-cycle estimate, or promo chunk. Written by the
 * calendar's PLAN CARD PAYMENT flow.
 */
export function paydownTargetDate(notes: string | null | undefined): string | undefined {
  return noteTagDate(notes, "pays-down");
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
 *   - Anywhere else is allowed — including after the issuer due date. Paying
 *     late is a choice the app records, not a mistake it blocks; pair with
 *     `cardPaymentLateWarning` to surface the interest note.
 *
 * `toDate === fromDate` is a no-op the caller should skip; it validates as null.
 */
export function cardPaymentMoveError(
  input: CardPaymentMoveInput,
  toDate: string,
  today: string,
): string | null {
  if (toDate < today) return "Choose today or a future date.";
  return null;
}

/**
 * Non-blocking companion to `cardPaymentMoveError`: the interest note for a
 * real card due (`paymentDueCents > 0`) being scheduled after its issuer due
 * date. Null when the chosen day carries no late-payment risk.
 */
export function cardPaymentLateWarning(input: CardPaymentMoveInput, toDate: string): string | null {
  if (input.isPaydown || input.paymentDueCents <= 0) return null;
  const dueDate = input.relatedDate ?? input.fromDate;
  if (toDate <= dueDate) return null;
  return `Scheduled after the ${dueDate} due date — the issuer may charge interest until it's paid.`;
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
  /**
   * Set on an OVERDUE marker (unpaid statements whose issuer due date already
   * passed, surfaced on today): the original due dates it aggregates. Any cash
   * scheduled toward it is late by definition.
   */
  overdueDueDates?: Set<string>;
  /**
   * Issuer minimum payment still owed for this cycle (recorded statements
   * only) — the realistic floor when the full balance can't be paid.
   */
  minimumCents?: number;
};

export function projectCardPayments(input: ProjectCardPaymentsInput): ProjectCardPaymentsResult {
  const { today, endDate, activeCards, promos, variableBills } = input;
  const stillInFlight = (cardId: string, date: string) =>
    (input.remainingPlannedCentsByKey?.get(overrideKey(cardId, date)) ?? 0) > 0;

  const cardById = new Map(activeCards.map((c) => [c.id, c] as const));
  // Statements arrive for EVERY card the user owns, archived ones included
  // (listStatementsForUser passes includeArchived so a card's history survives
  // archiving). The projection only speaks for cards still in the wallet:
  // promo chunks, scheduled payments and paydowns all already guard on
  // `cardById`, and the credit-cards page lists active cards only — so a due
  // marker naming an archived card is an obligation the user can see but
  // cannot open, edit, or clear. Archiving is the user saying "this card is
  // out of my life"; drop its statements here so the guard is uniform.
  const statements = input.statements.filter((s) => cardById.has(s.cardId));
  const balanceByPlaidAccount = new Map(
    input.plaidAccounts.map((a) => [a.id, a.balanceCents] as const),
  );

  const promoPaymentsByPromoId = new Map<string, Array<{ dueDate: string; amountCents: number }>>();
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
  for (const original of input.cardPaymentOverrides) {
    const o = {
      ...original,
      amountCents:
        input.remainingPlannedCentsByKey?.get(overrideKey(original.cardId, original.dueDate)) ??
        original.amountCents,
    };
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
    // matching `moved-from:` row. An explicit ZERO without a vacate note is
    // different: it's a per-cycle SKIP ("I'm not paying this projected chunk
    // this cycle") and must reach overrideByKey so it zeroes the promo/variable
    // cash on its date. Nothing is ever mandatory — including payoff plans.
    if (o.amountCents < 0) continue;
    if (o.amountCents === 0 && isMovedToVacate(o.notes)) continue;
    nonPaydownOverrides.push({
      cardId: o.cardId,
      date: o.dueDate,
      amountCents: o.amountCents,
      movedFrom: movedFromDate(o.notes),
    });
  }
  const overrideByKey = new Map<string, number>();
  for (const o of nonPaydownOverrides)
    overrideByKey.set(overrideKey(o.cardId, o.date), o.amountCents);
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
    {
      cardId: string;
      cardName: string;
      dueDate: string;
      amountCents: number;
      names: string[];
      categories: string[];
    }
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

  // ── Due-date markers (zero cash) ──────────────────────────────────────────
  // One per cycle per active card, from today through the projection window:
  // recorded statement when known, an estimate for a closed cycle not yet
  // recorded, open-cycle estimate for the current cycle, carried-forward
  // estimate for future cycles. Never debits checking.
  const promoDriftByCard: Record<string, number> = {};
  const markers: DueMarker[] = [];
  const markerKeys = new Set<string>();
  const pushMarker = (m: DueMarker) => {
    const key = overrideKey(m.cardId, m.dueDate);
    if (markerKeys.has(key)) return;
    markerKeys.add(key);
    markers.push(m);
  };

  // 1. Recorded statements. The owed amount is the Interest Saving Balance,
  // not the full statement balance: outstanding 0% promo principal isn't
  // exposed to interest and its future chunks are already projected as promo
  // cash on later due dates — marking the full balance here would both
  // overstate the interest risk and double-represent the promo principal.
  //
  // A statement whose due date already passed but still shows an unpaid ISB
  // portion is OVERDUE — the obligation didn't vanish with the date. It
  // surfaces on TODAY (same convention as expired promos) so it stays in view
  // and payments can still be aimed at it. Multiple overdue statements on one
  // card collapse into a single marker (summed owed, all original due dates).
  const overdueByCard = new Map<
    string,
    { cardName: string; owed: number; minimum: number; dueDates: Set<string> }
  >();
  for (const s of statements) {
    const isbDue = interestSavingCashDueCents(s, promosByCard.get(s.cardId) ?? []);
    const owed = Math.max(0, isbDue - (s.paidAmountCents ?? 0));
    if (owed <= 0) continue;
    // The issuer minimum still outstanding — the realistic floor when the full
    // balance can't be paid. Partial payments count toward it first.
    const minimum = Math.min(
      Math.max(0, (s.minimumPaymentCents ?? 0) - (s.paidAmountCents ?? 0)),
      owed,
    );
    if (s.dueDate < today) {
      const agg = overdueByCard.get(s.cardId) ?? {
        cardName: s.cardName,
        owed: 0,
        minimum: 0,
        dueDates: new Set<string>(),
      };
      agg.owed += owed;
      agg.minimum += minimum;
      agg.dueDates.add(s.dueDate);
      overdueByCard.set(s.cardId, agg);
      continue;
    }
    pushMarker({
      cardId: s.cardId,
      cardName: s.cardName,
      dueDate: s.dueDate,
      owedCents: owed,
      balanceCents: displayBalanceForCard(s.cardId, owed),
      estimated: false,
      minimumCents: minimum,
    });
  }
  for (const [cardId, agg] of overdueByCard) {
    // A statement can also be due exactly today — merge the overdue balance
    // into that marker rather than losing one of them to the per-key dedupe.
    const existing = markers.find((m) => m.cardId === cardId && m.dueDate === today);
    if (existing) {
      existing.owedCents += agg.owed;
      existing.balanceCents = Math.max(
        existing.balanceCents,
        displayBalanceForCard(cardId, existing.owedCents),
      );
      existing.overdueDueDates = agg.dueDates;
      existing.minimumCents = (existing.minimumCents ?? 0) + agg.minimum;
    } else {
      pushMarker({
        cardId,
        cardName: agg.cardName,
        dueDate: today,
        owedCents: agg.owed,
        balanceCents: displayBalanceForCard(cardId, agg.owed),
        estimated: false,
        overdueDueDates: agg.dueDates,
        minimumCents: agg.minimum,
      });
    }
  }

  // 2 + 3. Open-cycle estimate (this cycle) and carried-forward future cycles.
  // Manual (not Plaid-linked) cards' closed-cycle estimate markers, for the
  // past-payment cover rule in the coverage step.
  const closedCycleEstimateByCard = new Map<string, { marker: DueMarker; statementDate: string }>();
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
      const unpaid = unpaidRaw >= promoRemainingRaw ? unpaidRaw - promoRemainingRaw : unpaidRaw;
      // Cap the promo subtraction at the live-balance headroom so a drifted
      // promo total can't wipe the estimate to $0; record the overflow.
      const headroom = Math.max(0, liveBalance - unpaid);
      const promoRemaining = Math.min(promoRemainingRaw, headroom);
      const drift = promoRemainingRaw - promoRemaining;
      if (drift > 0) promoDriftByCard[card.id] = drift;
      recurringEstimate = Math.max(0, liveBalance - unpaid - promoRemaining);
    }
    if (recurringEstimate <= 0) continue;

    // 2a. The cycle that already CLOSED (strictly before today; a close dated
    // today is still the open cycle, as nextStatementDateOnOrAfter says) but
    // has no recorded statement yet: a manual card before the user enters it,
    // a Plaid card before the next liabilities sync. Its issuer due date comes
    // first, so without this marker the balance read as due one cycle late and
    // the 14-day interest alert missed the real due date. The live balance is
    // the best estimate of that statement (same estimate rules as below). A
    // due date that already passed gets nothing: with no statement there is no
    // evidence of an overdue debt beyond the balance the next cycles already
    // estimate. A recorded statement dated anywhere inside that cycle (Plaid's
    // issue date can drift from the configured day) is authoritative for it.
    const closedStatementDate = previousStatementDateOnOrBefore(addDaysIso(today, -1), card);
    const closedCycleStart = previousStatementDateOnOrBefore(
      addDaysIso(closedStatementDate, -1),
      card,
    );
    const closedDueDate = dueDateFromStatement(
      closedStatementDate,
      card.dueDay,
      card.gracePeriodDays,
    );
    const closedCycleRecorded =
      recordedDueDatesByCard.get(card.id)?.has(closedDueDate) === true ||
      statements.some(
        (s) =>
          s.cardId === card.id && s.statementDate > closedCycleStart && s.statementDate <= today,
      );
    if (closedDueDate >= today && closedDueDate <= endDate && !closedCycleRecorded) {
      // The due date can be today while an OVERDUE marker already rides on
      // today. Merge into it like the overdue + due-today statement merge
      // above (owed adds, it stays flagged overdue; an estimate adds no
      // minimum) instead of losing the estimate to the per-key dedupe.
      const existing = markers.find((m) => m.cardId === card.id && m.dueDate === closedDueDate);
      if (existing) {
        existing.owedCents += recurringEstimate;
        existing.balanceCents = Math.max(
          existing.balanceCents,
          displayBalanceForCard(card.id, existing.owedCents),
        );
      } else {
        const marker: DueMarker = {
          cardId: card.id,
          cardName: card.name,
          dueDate: closedDueDate,
          owedCents: recurringEstimate,
          balanceCents: Math.max(liveBalance ?? 0, recurringEstimate),
          estimated: true,
        };
        pushMarker(marker);
        if (!card.plaidAccountId) {
          closedCycleEstimateByCard.set(card.id, { marker, statementDate: closedStatementDate });
        }
      }
    }

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

  // A paydown targeting a promo/variable cash date reduces that cash chunk. One
  // targeting a statement/estimate marker date is display coverage only (the
  // marker has no cash). Classify accordingly.
  const cashChargeKeys = new Set<string>([
    ...promoChunksByCardDate.keys(),
    ...variableBillChargeGroups.keys(),
  ]);
  const paydownEntriesByTarget = new Map<string, Array<{ date: string; amountCents: number }>>();
  const prepayPoolByCard = new Map<string, number>();
  // Directed slices of the pool: moved-payment cash aimed back at the chunk
  // date it vacated. Applied before the soonest-first sweep.
  const directedPrepayByCard = new Map<string, Array<{ targetDate: string; amount: number }>>();
  const addPrepay = (cardId: string, amount: number, targetDate?: string) => {
    if (amount <= 0) return;
    prepayPoolByCard.set(cardId, (prepayPoolByCard.get(cardId) ?? 0) + amount);
    if (targetDate) {
      const list = directedPrepayByCard.get(cardId) ?? [];
      list.push({ targetDate, amount });
      directedPrepayByCard.set(cardId, list);
    }
  };
  // ONE budget per paydown, spent once across every generator at its target
  // (§17a): the due marker first (a statement up to what it owes, or the
  // card's shared estimate balance), then promo/variable cash on that date,
  // then — only when the target carried cash — later chunks via the prepay
  // sweep. Cover credited + cash removed never exceeds the paydown amount.
  const markerByTargetKey = new Map<string, DueMarker>();
  for (const m of markers) {
    markerByTargetKey.set(overrideKey(m.cardId, m.dueDate), m);
    // An overdue marker also answers to its original issuer due date(s).
    for (const d of m.overdueDueDates ?? []) markerByTargetKey.set(overrideKey(m.cardId, d), m);
  }
  const statementOpenByMarker = new Map<DueMarker, number>();
  const estimateOpenByCard = new Map<string, number>();
  // Estimate cash actually credited by paydowns, by cash date (running balance).
  const estimatePaydownCashByCard = new Map<string, Array<{ date: string; amt: number }>>();
  const chunkBudgetsByKey = new Map<string, Array<{ date: string; remaining: number }>>();
  const activePaydowns = paydowns
    .filter((p) => (p.date >= today || stillInFlight(p.cardId, p.date)) && p.amountCents > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const p of activePaydowns) {
    const key = overrideKey(p.cardId, p.targetDate);
    let budget = p.amountCents;
    const marker = markerByTargetKey.get(key);
    if (marker && !marker.estimated) {
      // Entries keep their payment date so coverage can tell on-time cash from
      // late cash (display only — the marker has no cash of its own).
      const open = statementOpenByMarker.get(marker) ?? marker.owedCents;
      const take = Math.min(budget, open);
      statementOpenByMarker.set(marker, open - take);
      budget -= take;
      if (take > 0) {
        const entries = paydownEntriesByTarget.get(key) ?? [];
        entries.push({ date: p.date, amountCents: take });
        paydownEntriesByTarget.set(key, entries);
      }
    } else if (marker?.estimated) {
      const open = estimateOpenByCard.get(p.cardId) ?? marker.owedCents;
      const take = Math.min(budget, open);
      estimateOpenByCard.set(p.cardId, open - take);
      budget -= take;
      if (take > 0) {
        const list = estimatePaydownCashByCard.get(p.cardId) ?? [];
        list.push({ date: p.date, amt: take });
        estimatePaydownCashByCard.set(p.cardId, list);
      }
    }
    // If that date ALSO carries promo/variable cash, what is left reduces it.
    if (cashChargeKeys.has(key)) {
      const list = chunkBudgetsByKey.get(key) ?? [];
      list.push({ date: p.date, remaining: budget });
      chunkBudgetsByKey.set(key, list);
    }
  }
  // Several generators can share one (card, date); consume from the same
  // budgets so a paydown is subtracted from the date's combined total once.
  const consumeAtChunk = (cardId: string, dueDate: string, baseCents: number): number => {
    let consumed = 0;
    for (const b of chunkBudgetsByKey.get(overrideKey(cardId, dueDate)) ?? []) {
      const take = Math.min(baseCents - consumed, b.remaining);
      if (take <= 0) continue;
      b.remaining -= take;
      consumed += take;
    }
    return consumed;
  };

  // An explicit $0 override on a chunk's date is a per-cycle SKIP: no cash
  // leaves checking, but the event stays visible (zero-amount, `skipped`) so
  // the calendar shows the skipped plan and the user can reset it. The balance
  // stays owed — promo remaining only changes through reconciliation.
  const promoExtras: OneTimeExpense[] = [];
  for (const chunk of promoChunksByCardDate.values()) {
    const key = overrideKey(chunk.cardId, chunk.dueDate);
    // An override sitting on the chunk's date replaces its amount ("edit this
    // promo payment") and is consumed here rather than becoming a separate cash
    // payment that would double-count.
    const override = overrideByKey.get(key);
    if (override != null) claimedOverrideKeys.add(key);
    const skipped = override === 0;
    const baseCents = override ?? chunk.amountCents;
    const consumed = consumeAtChunk(chunk.cardId, chunk.dueDate, baseCents);
    const amountCents = baseCents - consumed;
    if (amountCents <= 0 && !skipped) continue;
    promoExtras.push({
      date: chunk.dueDate,
      description: skipped
        ? `${chunk.cardName} promo (${chunk.descriptions.join(", ")}) — skipped`
        : `${chunk.cardName} promo (${chunk.descriptions.join(", ")})`,
      amountCents,
      sourceId: chunk.cardId,
      sourceType: "creditCardPayment",
      originalAmountCents: chunk.amountCents,
      paymentDueCents: skipped ? 0 : Math.max(0, chunk.amountCents - consumed),
      paymentBalanceCents: chunk.balanceCents,
      skipped: skipped || undefined,
    });
  }
  const variableBillExtras: OneTimeExpense[] = [];
  for (const group of variableBillChargeGroups.values()) {
    const key = overrideKey(group.cardId, group.dueDate);
    const override = overrideByKey.get(key);
    if (override != null) claimedOverrideKeys.add(key);
    const skipped = override === 0;
    const baseCents = override ?? group.amountCents;
    const consumed = consumeAtChunk(group.cardId, group.dueDate, baseCents);
    const amountCents = baseCents - consumed;
    if (amountCents <= 0 && !skipped) continue;
    variableBillExtras.push({
      date: group.dueDate,
      description: skipped
        ? `${group.cardName} variable spend (${group.names.join(", ")}) — skipped`
        : `${group.cardName} variable spend (${group.names.join(", ")})`,
      amountCents,
      sourceId: group.cardId,
      sourceType: "creditCardPayment",
      originalAmountCents: group.amountCents,
      paymentDueCents: amountCents,
      paymentBalanceCents: displayBalanceForCard(group.cardId, group.amountCents),
      skipped: skipped || undefined,
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
  // A paydown planned larger than its target marker + promo/variable chunk: the
  // excess knocks down that card's other chunks, soonest first — but only ones
  // dated on/after the paydown itself (money can't prepay a chunk that is due
  // before it leaves checking).
  const paydownExcess: Array<{ cardId: string; fromDate: string; amount: number }> = [];
  for (const [key, budgets] of chunkBudgetsByKey) {
    const cardId = key.slice(0, key.lastIndexOf(":"));
    for (const b of budgets) {
      if (b.remaining > 0) paydownExcess.push({ cardId, fromDate: b.date, amount: b.remaining });
    }
  }
  paydownExcess.sort((a, b) => a.fromDate.localeCompare(b.fromDate));

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
  const paymentsByCard = new Map<
    string,
    // `directTarget` is set on MOVED payments only: leftover cash from a
    // moved-from row must cancel the chunk it vacated, not the card's soonest.
    Array<{ date: string; remaining: number; targetDueDate: string; directTarget?: string }>
  >();
  for (const s of scheduledPayments) {
    if (s.amountCents <= 0) continue;
    const list = paymentsByCard.get(s.cardId) ?? [];
    list.push({
      date: s.date,
      remaining: s.amountCents,
      targetDueDate: s.targetDueDate,
      directTarget: s.relatedDate,
    });
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
    if (m.estimated) continue;
    statementMarkerKeys.add(overrideKey(m.cardId, m.dueDate));
    // An overdue marker also answers to its original issuer due date(s) — a
    // paydown stored against the passed date is still directed at it.
    for (const d of m.overdueDueDates ?? []) statementMarkerKeys.add(overrideKey(m.cardId, d));
  }
  for (const p of paydowns) {
    if ((p.date < today && !stillInFlight(p.cardId, p.date)) || p.amountCents <= 0) continue;
    const targetKey = overrideKey(p.cardId, p.targetDate);
    if (
      cashChargeKeys.has(targetKey) ||
      statementMarkerKeys.has(targetKey) ||
      estimatedDuesByCard.get(p.cardId)?.has(p.targetDate)
    ) {
      continue;
    }
    const list = paymentsByCard.get(p.cardId) ?? [];
    list.push({ date: p.date, remaining: p.amountCents, targetDueDate: p.targetDate });
    paymentsByCard.set(p.cardId, list);
  }
  for (const list of paymentsByCard.values()) list.sort((a, b) => a.date.localeCompare(b.date));

  const coverByMarker = new Map<DueMarker, number>();
  const lateCoverByMarker = new Map<DueMarker, number>();
  for (const [cardId, cardMarkers] of markersByCard) {
    const pool = paymentsByCard.get(cardId) ?? [];
    const statementMarkers = cardMarkers.filter((m) => !m.estimated);
    const estimateMarkers = cardMarkers.filter((m) => m.estimated);

    // 1. Recorded statements: explicit paydowns + pool payments, earliest due
    //    first (an overdue marker sits on today, so it drinks from the pool
    //    before future statements — the issuer applies cash to what's already
    //    owed). Cash dated on/before the issuer due date is ON-TIME cover;
    //    cash dated after it — a deliberately late plan, or anything aimed at
    //    an overdue marker — is LATE cover: it still counts toward the
    //    balance, but the marker keeps carrying the interest note. Undirected
    //    pool cash never covers a future statement late (it flows on to the
    //    next due it precedes instead); only directed cash (moved-from /
    //    pays-down) and overdue markers accept late money.
    for (const sm of statementMarkers) {
      const overdue = sm.overdueDueDates != null;
      const targetKeys = new Set<string>([overrideKey(cardId, sm.dueDate)]);
      for (const d of sm.overdueDueDates ?? []) targetKeys.add(overrideKey(cardId, d));
      let onTime = 0;
      let late = 0;
      for (const key of targetKeys) {
        for (const pd of paydownEntriesByTarget.get(key) ?? []) {
          if (overdue || pd.date > sm.dueDate) late += pd.amountCents;
          else onTime += pd.amountCents;
        }
      }
      for (const p of pool) {
        if (onTime + late >= sm.owedCents) break;
        if (p.remaining <= 0) continue;
        const onTimeHere = !overdue && p.date <= sm.dueDate;
        const directedHere = targetKeys.has(overrideKey(cardId, p.targetDueDate));
        if (!onTimeHere && !directedHere && !overdue) continue;
        const take = Math.min(p.remaining, sm.owedCents - onTime - late);
        p.remaining -= take;
        if (onTimeHere) onTime += take;
        else late += take;
      }
      const cover = Math.min(onTime + late, sm.owedCents);
      coverByMarker.set(sm, cover);
      lateCoverByMarker.set(sm, Math.min(late, cover));
    }

    // 2. Estimated cycles share one running balance (recurringEstimate). Cash
    // paid down against it — plain payments left after statements, plus paydowns
    // aimed at an estimated due date — reduces every cycle on/after the cash date.
    if (estimateMarkers.length > 0) {
      const estBalance = estimateMarkers[0]!.owedCents;
      const estCash: Array<{ date: string; amt: number }> = [];
      for (const p of pool) if (p.remaining > 0) estCash.push({ date: p.date, amt: p.remaining });
      // Only the share of each paydown budget the estimate actually consumed.
      estCash.push(...(estimatePaydownCashByCard.get(cardId) ?? []));
      for (const em of estimateMarkers) {
        let cumulative = 0;
        for (const c of estCash) if (c.date <= em.dueDate) cumulative += c.amt;
        coverByMarker.set(em, Math.min(estBalance, cumulative));
      }
      // Plain cash beyond what the estimate can absorb credits promo chunks.
      const plainLeftover = pool.reduce((s, p) => s + Math.max(0, p.remaining), 0);
      addPrepay(cardId, Math.max(0, plainLeftover - estBalance));
    } else {
      for (const p of pool) addPrepay(cardId, p.remaining, p.directTarget);
    }
  }
  // Cards with scheduled payments but no markers at all: their cash credits promo.
  for (const [cardId, pool] of paymentsByCard) {
    if (markersByCard.has(cardId)) continue;
    for (const p of pool) addPrepay(cardId, p.remaining, p.directTarget);
  }

  // 3. A MANUAL card's balance does not move when the user pays, so a payment
  // already made toward the closed cycle (dated after its close, before today)
  // still covers that cycle's estimate — while the card has not been edited
  // on/after the payment date (an edit means the balance may already show it).
  // Display cover only, on that one marker, capped at what it owes.
  //
  // It may only add money NO rule above already credits: per row, the
  // original amount minus the amount the engine still treats as effective.
  //   • plain / moved-from rows are never date-filtered: their effective
  //     amount (`remaining ?? original`) is already in the cover pool, so
  //     only a linked-checking posted part (original − remaining) is new;
  //   • pays-down rows dated before today drop out of every rule unless
  //     still in flight, so all but the unposted remainder is new.
  // Rows that may have paid a promo/variable chunk instead of this cycle are
  // skipped: the chunk claim only sees chunks dated today or later, so a past
  // row (or the date a paydown / moved payment aimed at) on a due-day
  // occurrence, a promo deadline or a scheduled promo payment date never
  // counts here — except a paydown aimed at the closed cycle's own due date,
  // which spends on the marker first (§17a). `moved-to:` rows never count.
  for (const [cardId, closed] of closedCycleEstimateByCard) {
    const editedOn = input.cardEditedOnByCard?.get(cardId);
    const card = cardById.get(cardId);
    if (editedOn == null || !card) continue;
    const cardPromos = promosByCard.get(cardId) ?? [];
    const mayBeChunkDate = (date: string) =>
      nextDayOfMonthOnOrAfter(date, card.dueDay) === date ||
      cardPromos.some(
        (p) =>
          p.endDate === date ||
          (promoPaymentsByPromoId.get(p.id) ?? []).some((pp) => pp.dueDate === date),
      );
    let past = 0;
    for (const o of input.cardPaymentOverrides) {
      if (o.cardId !== cardId || o.amountCents <= 0 || isMovedToVacate(o.notes)) continue;
      if (o.dueDate <= closed.statementDate || o.dueDate >= today || editedOn >= o.dueDate) {
        continue;
      }
      const key = overrideKey(cardId, o.dueDate);
      if (claimedOverrideKeys.has(key) || mayBeChunkDate(o.dueDate)) continue;
      const remaining = input.remainingPlannedCentsByKey?.get(key);
      const paydownTarget = paydownTargetDate(o.notes);
      let effective: number;
      if (paydownTarget != null) {
        if (paydownTarget !== closed.marker.dueDate && mayBeChunkDate(paydownTarget)) continue;
        effective = Math.max(0, remaining ?? 0); // in flight → unposted remainder, else 0
      } else {
        const movedFrom = movedFromDate(o.notes);
        if (movedFrom != null && mayBeChunkDate(movedFrom)) continue;
        effective = Math.max(0, remaining ?? o.amountCents); // already in the pool
      }
      past += Math.max(0, o.amountCents - effective);
    }
    if (past <= 0) continue;
    const m = closed.marker;
    coverByMarker.set(m, Math.min(m.owedCents, (coverByMarker.get(m) ?? 0) + past));
  }

  // Apply the prepayment pool (scheduled surplus) and the paydown excess to
  // each card's promo/variable chunks: moved-payment cash cancels the chunk it
  // vacated first, then paydown excess sweeps soonest-first from its own date,
  // then whatever pool remains sweeps soonest-first. Fully-covered chunks drop out.
  if (prepayPoolByCard.size > 0 || paydownExcess.length > 0) {
    const excessCards = new Set(paydownExcess.map((x) => x.cardId));
    const creditable = [...promoExtras, ...variableBillExtras]
      .filter(
        (e) =>
          e.sourceId != null && (prepayPoolByCard.has(e.sourceId) || excessCards.has(e.sourceId)),
      )
      .sort((a, b) =>
        a.sourceId === b.sourceId
          ? a.date.localeCompare(b.date)
          : a.sourceId!.localeCompare(b.sourceId!),
      );
    const reduceChunk = (e: OneTimeExpense, cents: number) => {
      e.amountCents -= cents;
      e.paymentDueCents = Math.max(0, (e.paymentDueCents ?? 0) - cents);
    };
    const applyCredit = (e: OneTimeExpense, cents: number) => {
      reduceChunk(e, cents);
      prepayPoolByCard.set(e.sourceId!, (prepayPoolByCard.get(e.sourceId!) ?? 0) - cents);
    };
    for (const [cardId, targets] of directedPrepayByCard) {
      for (const t of targets) {
        const pool = prepayPoolByCard.get(cardId) ?? 0;
        if (pool <= 0) break;
        const target = creditable.find(
          (e) => e.sourceId === cardId && e.date === t.targetDate && e.amountCents > 0,
        );
        if (!target) continue;
        applyCredit(target, Math.min(pool, t.amount, target.amountCents));
      }
    }
    for (const x of paydownExcess) {
      let left = x.amount;
      for (const e of creditable) {
        if (left <= 0) break;
        if (e.sourceId !== x.cardId || e.date < x.fromDate || e.amountCents <= 0) continue;
        const take = Math.min(left, e.amountCents);
        reduceChunk(e, take);
        left -= take;
      }
    }
    for (const e of creditable) {
      const pool = prepayPoolByCard.get(e.sourceId!) ?? 0;
      if (pool <= 0 || e.amountCents <= 0) continue;
      applyCredit(e, Math.min(pool, e.amountCents));
    }
  }
  // Skipped chunks carry no cash but must stay visible (resettable).
  const promoCashExtras = promoExtras.filter((e) => e.amountCents > 0 || e.skipped);
  const variableCashExtras = variableBillExtras.filter((e) => e.amountCents > 0 || e.skipped);
  const promoCashByCard: Record<string, number> = {};
  for (const e of promoCashExtras) {
    if (e.sourceId == null || e.amountCents <= 0 || e.date > endDate) continue;
    promoCashByCard[e.sourceId] = (promoCashByCard[e.sourceId] ?? 0) + e.amountCents;
  }

  const markerExtras: OneTimeExpense[] = markers.map((m) => {
    const cover = Math.min(coverByMarker.get(m) ?? 0, m.owedCents);
    const lateCover = Math.min(lateCoverByMarker.get(m) ?? 0, cover);
    const overdueSince = m.overdueDueDates ? [...m.overdueDueDates].sort()[0] : undefined;
    return {
      date: m.dueDate,
      description: m.estimated
        ? `${m.cardName} (est.)`
        : overdueSince
          ? `${m.cardName} (overdue)`
          : m.cardName,
      amountCents: 0,
      sourceId: m.cardId,
      sourceType: "creditCardPayment" as const,
      originalAmountCents: m.owedCents,
      // The original issuer due date, so the payment planner aims moved cash
      // at the passed date (directed late cover) instead of at today.
      relatedDate: overdueSince,
      paymentDueCents: m.owedCents,
      paymentMinimumCents: m.minimumCents,
      paymentBalanceCents: m.balanceCents,
      dueMarker: true,
      scheduledCoverCents: cover,
      lateCoverCents: lateCover,
      overdueSinceDate: overdueSince,
      estimated: m.estimated,
    };
  });

  // ── Scheduled payments → cash-out on their own dates ──────────────────────
  const plannedCardExtras: OneTimeExpense[] = [];
  for (const s of scheduledPayments) {
    const card = cardById.get(s.cardId);
    // A $0 row that wasn't claimed by a chunk (a skip saved on a marker date)
    // is inert — no cash, nothing to render.
    if (!card || s.amountCents <= 0) continue;
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
  for (const e of variableCashExtras) kindByEvent.set(e, "variable");
  for (const e of plannedCardExtras) kindByEvent.set(e, "planned");
  const cashExtras = mergeByDueDate(
    [...promoCashExtras, ...variableCashExtras, ...plannedCardExtras],
    kindByEvent,
    cardById,
  );

  return {
    extras: [...markerExtras, ...cashExtras],
    promoDriftByCard,
    variableBillCategoriesByKey,
    promoCashByCard,
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
    // A merged row is a skip only when every member is one (a single $0
    // override zeroes all chunks sharing its date); skip + real cash is cash.
    const skipped = group.every((e) => e.skipped);
    out.push({
      ...first,
      description: `${cardName} payment (${kinds.join(" + ")})${skipped ? " — skipped" : ""}`,
      skipped: skipped || undefined,
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
