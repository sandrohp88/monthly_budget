import "server-only";
import { addDaysIso, todayIso } from "./dates";
import {
  getSettings,
  listBillPaymentOverridesForUser,
  listBills,
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
};

export async function buildProjection(userId: string): Promise<ProjectionBundle | null> {
  const settings = await getSettings(userId);
  if (!settings) return null;

  const today = todayIso(settings.timezone);
  const startDate = settings.firstPaydayDate < today ? settings.firstPaydayDate : today;

  // End date = today + projectionMonths (approx, using 31 days per month for a safe upper bound).
  const endDate = addDaysIso(today, settings.projectionMonths * 31);

  const [
    bills,
    billPaymentOverrides,
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
  const openCycleExtras: { date: string; description: string; amountCents: number }[] = [];
  for (const card of activeCards) {
    if (!card.plaidAccountId) continue;
    const liveBalance = balanceByPlaidAccount.get(card.plaidAccountId);
    if (liveBalance == null || liveBalance <= 0) continue;
    const unpaid = unpaidByCard.get(card.id) ?? 0;
    const promoRemaining = promoRemainingByCard.get(card.id) ?? 0;
    const openCycleCents = Math.max(0, liveBalance - unpaid - promoRemaining);
    if (openCycleCents <= 0) continue;
    const nextStatement = nextStatementDateOnOrAfter(today, card);
    openCycleExtras.push({
      date: dueDateFromStatement(nextStatement, card.dueDay),
      description: `${card.name} next payment (est)`,
      amountCents: openCycleCents,
    });
  }

  // Promotional financing: each active promo contributes one debit per future
  // cycle's due date through its endDate. Cycles already covered by a recorded
  // statement (paid OR unpaid) are SKIPPED — recorded statements are
  // authoritative for the cash they demand on their due date, and the
  // statement balance entered by the user is assumed to already include any
  // promo chunk billed in that cycle.
  const recordedDueDatesByCard = new Map<string, Set<string>>();
  for (const s of statements) {
    let set = recordedDueDatesByCard.get(s.cardId);
    if (!set) {
      set = new Set();
      recordedDueDatesByCard.set(s.cardId, set);
    }
    set.add(s.dueDate);
  }
  const cardById = new Map(activeCards.map((c) => [c.id, c] as const));
  const promoExtras: { date: string; description: string; amountCents: number }[] = [];
  for (const promo of promos) {
    const card = cardById.get(promo.cardId);
    if (!card) continue; // archived card → promo also pauses (promo monthly cash floats away)
    const skip = recordedDueDatesByCard.get(promo.cardId) ?? new Set<string>();
    const schedule = projectPromoSchedule(promo, card, today, skip);
    for (const chunk of schedule) {
      promoExtras.push({
        date: chunk.dueDate,
        description: `${card.name} promo (${promo.description})`,
        amountCents: chunk.amountCents,
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
      ...extras.map((e) => ({
        date: e.date,
        description: e.description,
        amountCents: e.amountCents,
      })),
      ...ccExtras,
      ...openCycleExtras,
      ...promoExtras,
    ],
  };

  return {
    rows: computeProjection(input),
    startDate,
    endDate,
    today,
    startingBalanceCents: effectiveStartingBalance,
    projectionMonths: settings.projectionMonths,
    currency: settings.currency,
  };
}
