import "server-only";
import { addDaysIso, startOfMonthIso, todayIso } from "./dates";
import {
  getSettings,
  listBillPaymentOverridesForUser,
  listBills,
  listCreditCardPaymentOverridesForUser,
  listCreditCards,
  listExtras,
  listPaychecks,
  listPlaidAccounts,
  listPromos,
  listStatementsForUser,
  getPrimaryLinkedBalance,
} from "./repos";
import {
  dueDateFromStatement,
  nextStatementDateOnOrAfter,
  projectPromoSchedule,
} from "./credit-cards";
import { computeProjection, type ProjectionInput, type ProjectionRow } from "./projection";

export type PromoPaymentSummary = {
  id: string;
  cardId: string;
  description: string;
  remainingAmountCents: number;
  endDate: string;
  monthlyPaymentCents: number | null;
};

export type ProjectionBundle = {
  rows: ProjectionRow[];
  startDate: string;
  endDate: string;
  /** Today in the user's configured timezone — exposed so client filters
   *  can compute date windows without re-deriving the timezone. */
  today: string;
  startingBalanceCents: number;
  projectionMonths: number;
  currency: string;
  promoSummariesByCard: Record<string, PromoPaymentSummary[]>;
};

export async function buildProjection(userId: string): Promise<ProjectionBundle | null> {
  const settings = await getSettings(userId);
  if (!settings) return null;

  const today = todayIso(settings.timezone);
  const startDate =
    settings.firstPaydayDate < today ? settings.firstPaydayDate : startOfMonthIso(today);

  // End date = today + projectionMonths (approx, using 31 days per month for a safe upper bound).
  const endDate = addDaysIso(today, settings.projectionMonths * 31);

  const [
    bills,
    billPaymentOverrides,
    creditCardPaymentOverrides,
    paychecks,
    extras,
    statements,
    activeCards,
    linkedBalance,
    plaidAccts,
    promos,
  ] =
    await Promise.all([
      listBills(userId, false),
      listBillPaymentOverridesForUser(userId),
      listCreditCardPaymentOverridesForUser(userId),
      listPaychecks(userId),
      listExtras(userId),
      listStatementsForUser(userId),
      listCreditCards(userId, false),
      getPrimaryLinkedBalance(userId),
      listPlaidAccounts(userId),
      listPromos(userId, false),
    ]);
  const activeCardIds = new Set(activeCards.map((c) => c.id));
  const billOverridesByBill = new Map<string, Array<{ date: string; amountCents: number }>>();
  for (const override of billPaymentOverrides) {
    const list = billOverridesByBill.get(override.billId) ?? [];
    list.push({ date: override.dueDate, amountCents: override.amountCents });
    billOverridesByBill.set(override.billId, list);
  }
  const cardOverridesByCard = new Map<string, Map<string, { amountCents: number; notes: string | null }>>();
  for (const override of creditCardPaymentOverrides) {
    let byDate = cardOverridesByCard.get(override.cardId);
    if (!byDate) {
      byDate = new Map<string, { amountCents: number; notes: string | null }>();
      cardOverridesByCard.set(override.cardId, byDate);
    }
    byDate.set(override.dueDate, {
      amountCents: override.amountCents,
      notes: override.notes,
    });
  }
  const appliedCardOverrideKeys = new Set<string>();
  const overrideKey = (cardId: string, dueDate: string) => `${cardId}:${dueDate}`;
  const movedFromDate = (notes: string | null | undefined): string | undefined => {
    const match = notes?.match(/(?:^|\s)moved-from:(\d{4}-\d{2}-\d{2})(?:\s|$)/);
    return match?.[1];
  };

  // Bills paid via an ACTIVE credit card don't move cash on their own — the
  // card's statement payment carries them. Skip them from the projection to
  // avoid double-counting. Bills linked to an archived card fall back to cash
  // so we never silently lose visibility of a recurring obligation.
  const cashBills = bills.filter(
    (b) => b.paidViaCardId == null || !activeCardIds.has(b.paidViaCardId),
  );

  // Unpaid credit-card statements become extras on their due date so the
  // projection deducts them from the running balance. Paid statements are
  // already reflected in the starting balance and are skipped.
  const ccExtras = statements
    .filter((s) => s.paidAmountCents == null)
    .map((s) => ({
      date: s.dueDate,
      description: `${s.cardName} payment`,
      amountCents: s.statementBalanceCents,
    }));

  // Open-cycle estimate per Plaid-linked active card: the live card balance
  // minus any unpaid statements minus the unbilled promo principal is the
  // floor of what's been spent in the current open cycle, which will land on
  // the next statement and be due on the dueDate after that. Subtracting
  // unpaid statements avoids double-counting them (they're already in
  // ccExtras above). Subtracting promo remaining avoids projecting unbilled
  // promo principal as a single lump on the next due date — promos contribute
  // their own monthly chunks via promoExtras below.
  const balanceByPlaidAccount = new Map(plaidAccts.map((a) => [a.id, a.balanceCents] as const));
  const unpaidByCard = new Map<string, number>();
  for (const s of statements) {
    if (s.paidAmountCents == null) {
      unpaidByCard.set(s.cardId, (unpaidByCard.get(s.cardId) ?? 0) + s.statementBalanceCents);
    }
  }
  const promoRemainingByCard = new Map<string, number>();
  for (const p of promos) {
    promoRemainingByCard.set(
      p.cardId,
      (promoRemainingByCard.get(p.cardId) ?? 0) + p.remainingAmountCents,
    );
  }
  const openCycleExtras: ProjectionInput["extras"] = [];
  for (const card of activeCards) {
    const liveBalance = card.plaidAccountId
      ? balanceByPlaidAccount.get(card.plaidAccountId)
      : card.currentBalanceCents;
    if (liveBalance == null || liveBalance <= 0) continue;
    const unpaid = unpaidByCard.get(card.id) ?? 0;
    const promoRemaining = promoRemainingByCard.get(card.id) ?? 0;
    const openCycleCents = Math.max(0, liveBalance - unpaid - promoRemaining);
    if (openCycleCents <= 0) continue;
    const nextStatement = nextStatementDateOnOrAfter(today, card);
    const dueDate = dueDateFromStatement(nextStatement, card.dueDay);
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
      });
    }
  }

  // Promotional financing: each active promo contributes one debit per future
  // cycle's due date through its endDate. Statement rows only suppress promo
  // chunks when they already represent cash movement. This matters for 0% APR
  // promos where the issuer can report $0 due to avoid interest, while the user
  // still wants a planned monthly paydown in the current cycle.
  const recordedDueDatesByCard = new Map<string, Set<string>>();
  for (const s of statements) {
    const coveredCashCents = s.paidAmountCents ?? s.statementBalanceCents;
    if (coveredCashCents <= 0) continue;
    let set = recordedDueDatesByCard.get(s.cardId);
    if (!set) {
      set = new Set();
      recordedDueDatesByCard.set(s.cardId, set);
    }
    set.add(s.dueDate);
  }
  const cardById = new Map(activeCards.map((c) => [c.id, c] as const));
  const promoChunksByCardDate = new Map<
    string,
    { cardId: string; cardName: string; dueDate: string; amountCents: number }
  >();
  for (const promo of promos) {
    const card = cardById.get(promo.cardId);
    if (!card) continue; // archived card → promo also pauses (promo monthly cash floats away)
    const skip = recordedDueDatesByCard.get(promo.cardId) ?? new Set<string>();
    const schedule = projectPromoSchedule(promo, card, today, skip);
    for (const chunk of schedule) {
      const key = overrideKey(card.id, chunk.dueDate);
      const existing = promoChunksByCardDate.get(key);
      if (existing) {
        existing.amountCents += chunk.amountCents;
      } else {
        promoChunksByCardDate.set(key, {
          cardId: card.id,
          cardName: card.name,
          dueDate: chunk.dueDate,
          amountCents: chunk.amountCents,
        });
      }
    }
  }
  const promoExtras: ProjectionInput["extras"] = [];
  for (const chunk of promoChunksByCardDate.values()) {
    const override = cardOverridesByCard.get(chunk.cardId)?.get(chunk.dueDate);
    appliedCardOverrideKeys.add(overrideKey(chunk.cardId, chunk.dueDate));
    const amountCents = override?.amountCents ?? chunk.amountCents;
    if (amountCents <= 0) continue;
    promoExtras.push({
      date: chunk.dueDate,
      description: `${chunk.cardName} promo payment`,
      amountCents,
      sourceId: chunk.cardId,
      sourceType: "creditCardPayment",
      originalAmountCents: chunk.amountCents,
      relatedDate: movedFromDate(override?.notes),
    });
  }

  const plannedCardExtras: ProjectionInput["extras"] = [];
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
      });
    }
  }

  // Opt-in: if the user has marked a linked account as their starting balance source,
  // substitute its live balance for the manual startingBalanceCents.
  const effectiveStartingBalance = linkedBalance ?? settings.startingBalanceCents;

  const input: ProjectionInput = {
    startingBalanceCents: effectiveStartingBalance,
    startDate,
    endDate,
    paychecks: paychecks.map((p) => ({
      payDate: p.payDate,
      amountCents: p.actualReceived && p.actualAmountCents != null ? p.actualAmountCents : p.amountCents,
      note: p.note,
    })),
    bills: cashBills.map((b) => ({
      id: b.id,
      name: b.name,
      amountCents: b.amountCents,
      intervalMonths: b.intervalMonths,
      anchorDate: b.anchorDate,
      paymentOverrides: billOverridesByBill.get(b.id) ?? [],
    })),
    extras: [
      ...extras
        .filter((e) => e.paidViaCardId == null || !activeCardIds.has(e.paidViaCardId))
        .map((e) => ({
        date: e.date,
        description: e.description,
        amountCents: e.amountCents,
      })),
      ...ccExtras,
      ...openCycleExtras,
      ...promoExtras,
      ...plannedCardExtras,
    ],
  };
  const promoSummariesByCard: Record<string, PromoPaymentSummary[]> = {};
  for (const promo of promos) {
    if (!promo.isActive || promo.remainingAmountCents <= 0 || !activeCardIds.has(promo.cardId)) continue;
    const list = promoSummariesByCard[promo.cardId] ?? [];
    list.push({
      id: promo.id,
      cardId: promo.cardId,
      description: promo.description,
      remainingAmountCents: promo.remainingAmountCents,
      endDate: promo.endDate,
      monthlyPaymentCents: promo.monthlyPaymentCents,
    });
    promoSummariesByCard[promo.cardId] = list;
  }
  for (const list of Object.values(promoSummariesByCard)) {
    list.sort((a, b) => a.endDate.localeCompare(b.endDate));
  }

  return {
    rows: computeProjection(input),
    startDate,
    endDate,
    today,
    startingBalanceCents: effectiveStartingBalance,
    projectionMonths: settings.projectionMonths,
    currency: settings.currency,
    promoSummariesByCard,
  };
}
