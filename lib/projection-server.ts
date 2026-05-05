import "server-only";
import { addDaysIso, todayIso } from "./dates";
import {
  getSettings,
  listBillPaymentOverridesForUser,
  listBills,
  listCreditCardPaymentOverridesForUser,
  listCreditCards,
  listExtras,
  listPaychecks,
  listPlaidAccounts,
  listAllPromoPayments,
  listPromos,
  listStatementsForUser,
  getPrimaryLinkedBalance,
} from "./repos";
import {
  dueDateFromStatement,
  nextStatementDateOnOrAfter,
  projectPromoScheduleWithBalances,
} from "./credit-cards";
import {
  computeProjection,
  resolveProjectionStartDate,
  type ProjectionInput,
  type ProjectionRow,
} from "./projection";

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
    promoPayments,
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
      listAllPromoPayments(userId),
    ]);
  const promoPaymentsByPromoId = new Map<
    string,
    Array<{ dueDate: string; amountCents: number }>
  >();
  for (const pp of promoPayments) {
    const list = promoPaymentsByPromoId.get(pp.promoId) ?? [];
    list.push({ dueDate: pp.dueDate, amountCents: pp.amountCents });
    promoPaymentsByPromoId.set(pp.promoId, list);
  }
  const activeCardIds = new Set(activeCards.map((c) => c.id));
  const cardById = new Map(activeCards.map((c) => [c.id, c] as const));
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

  // Open-cycle estimate per Plaid-linked active card: the live card balance
  // minus any unpaid statements minus the unbilled promo principal is the
  // floor of what's been spent in the current open cycle, which will land on
  // the next statement and be due on the dueDate after that. Subtracting
  // unpaid statements avoids double-counting them (they become ccExtras).
  // Subtracting promo remaining avoids projecting unbilled
  // promo principal as a single lump on the next due date — promos contribute
  // their own monthly chunks via promoExtras below.
  const balanceByPlaidAccount = new Map(plaidAccts.map((a) => [a.id, a.balanceCents] as const));
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
    return Math.max(
      liveBalance ?? 0,
      fallbackDueCents,
      promoRemainingByCard.get(cardId) ?? 0,
    );
  };

  // Unpaid credit-card statements become extras on their due date so the
  // projection deducts them from the running balance. Paid statements are
  // already reflected in the starting balance and are skipped. These events
  // also carry card-balance metadata so a user can plan paying above the
  // statement due amount when a 0% promo balance is present.
  const ccExtras: ProjectionInput["extras"] = statements
    .map((s) => {
      const remainingCents = Math.max(0, s.statementBalanceCents - (s.paidAmountCents ?? 0));
      if (remainingCents <= 0) return null;
      const override = cardOverridesByCard.get(s.cardId)?.get(s.dueDate);
      appliedCardOverrideKeys.add(overrideKey(s.cardId, s.dueDate));
      const amountCents = override?.amountCents ?? remainingCents;
      return {
        date: s.dueDate,
        description: `${s.cardName} payment`,
        amountCents,
        sourceId: s.cardId,
        sourceType: "creditCardPayment" as const,
        originalAmountCents: remainingCents,
        relatedDate: movedFromDate(override?.notes),
        paymentDueCents: remainingCents,
        paymentBalanceCents: displayBalanceForCard(s.cardId, remainingCents),
      };
    })
    .filter((extra): extra is NonNullable<typeof extra> => extra !== null);

  const openCycleExtras: ProjectionInput["extras"] = [];
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
    // promo total would wipe out a $3k open-cycle estimate to $0.
    const promoRemainingRaw = promoRemainingByCard.get(card.id) ?? 0;
    const promoRemaining = Math.min(promoRemainingRaw, Math.max(0, liveBalance - unpaid));
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
        paymentDueCents: openCycleCents,
        paymentBalanceCents: Math.max(liveBalance, openCycleCents),
      });
    }
  }

  // Promotional financing: each active promo contributes one debit per future
  // cycle's due date through its endDate. A recorded statement suppresses promo
  // chunks for that due date even when the statement due amount is $0: issuer
  // statements are authoritative for due balances, while optional paydowns
  // should be modeled as explicit planned card payments.
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
  const promoExtras: ProjectionInput["extras"] = [];
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
        paymentDueCents: 0,
        paymentBalanceCents: displayBalanceForCard(cardId, 0),
      });
    }
  }

  // Opt-in: if the user has marked a linked account as their starting balance source,
  // substitute its live balance for the manual startingBalanceCents.
  const effectiveStartingBalance = linkedBalance ?? settings.startingBalanceCents;
  const startDate = resolveProjectionStartDate({
    firstPaydayDate: settings.firstPaydayDate,
    today,
    usesLinkedStartingBalance: linkedBalance != null,
  });

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
