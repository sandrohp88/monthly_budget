import "server-only";
import { cache } from "react";
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
  listStartingBalanceDraftsInRange,
  listStatementsForUser,
  listVariableBills,
  getPrimaryLinkedBalance,
} from "./repos";
import {
  computeProjection,
  resolveProjectionStartDate,
  type OneTimeExpense,
  type ProjectionInput,
  type ProjectionRow,
} from "./projection";
import { projectCardPayments } from "./card-payments";
import { matchPaidBillOccurrences } from "./bill-reconciliation";

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
  /**
   * Per-card "promo records exceed the live card balance after subtracting
   * unpaid statements" amount in cents. Nonzero values mean our promo state
   * is drifting higher than the issuer actually has on file — typically
   * because the unpaid→paid edge that decrements promos didn't fire (e.g.
   * Plaid never reported a payment, or the statement was marked paid with
   * $0). The projection silently caps the subtraction so the open-cycle
   * estimate doesn't go negative; the UI should surface this so the user
   * knows to reconcile.
   */
  promoDriftByCard: Record<string, number>;
  /** Category names for variable bill charge groups, keyed by `cardId:dueDate`. */
  variableBillCategoriesByKey: Record<string, string[]>;
  /**
   * Posted Plaid drafts that settled a bill occurrence (linked mode only),
   * keyed by draft id. Lets the transactions page mark a row as "this paid
   * bill X" using the exact same matches the projection acted on.
   */
  billMatchesByDraftId: Record<
    string,
    { billId: string; billName: string; occurrenceDate: string }
  >;
};

export const buildProjection = cache(_buildProjection);

async function _buildProjection(userId: string): Promise<ProjectionBundle | null> {
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
    variableBills,
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
      listVariableBills(userId, false),
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

  // All credit-card cash-out (statements, open-cycle estimate, promo chunks,
  // variable spend, planned payments) is computed in one place. The
  // authoritative-statement rule and override coordination live inside.
  const cardPayments = projectCardPayments({
    today,
    endDate,
    activeCards,
    statements,
    promos,
    promoPayments,
    variableBills,
    plaidAccounts: plaidAccts,
    cardPaymentOverrides: creditCardPaymentOverrides,
  });

  // Opt-in: if the user has marked a linked account as their starting balance source,
  // substitute its live balance for the manual startingBalanceCents.
  const linked = linkedBalance != null;
  const requestedStartDate = resolveProjectionStartDate({
    startingBalanceAsOf: settings.startingBalanceAsOf,
    today,
    usesLinkedStartingBalance: linked,
  });
  // Cap linked-mode lookback at MAX_LOOKBACK_DAYS so the schema default for
  // startingBalanceAsOf (1970-01-01, used by users who never set the field)
  // doesn't replay decades of Plaid drafts on every projection build.
  const MAX_LOOKBACK_DAYS = 180;
  const earliestLookback = addDaysIso(today, -MAX_LOOKBACK_DAYS);
  const startDate =
    linked && requestedStartDate < earliestLookback ? today : requestedStartDate;
  // Lookback: linked + the user has rolled startingBalanceAsOf to a past date
  // (within the cap) to see historical context — paid bills, recent expenses
  // — alongside the forward projection. Past balances are reconstructed from
  // posted Plaid drafts on the linked starting-balance accounts.
  const lookback = linked && startDate < today;

  const historicalDrafts = lookback
    ? await listStartingBalanceDraftsInRange(userId, startDate, today)
    : [];

  // Reconcile posted payments against generated bill occurrences so a bill
  // that was already paid this cycle (e.g. the utility payment visible in
  // transactions) shows as a PAID marker instead of a pending debit. Linked
  // mode only: the live balance already reflects the posted payment, so
  // projecting the occurrence again would double-count; in manual mode the
  // occurrence must keep debiting the running balance.
  const RECONCILE_LOOKBACK_DAYS = 45;
  const paidOccurrencesByBill = new Map<
    string,
    Array<{ date: string; paidAmountCents?: number }>
  >();
  const billMatchesByDraftId: ProjectionBundle["billMatchesByDraftId"] = {};
  if (linked) {
    const recentDrafts = await listStartingBalanceDraftsInRange(
      userId,
      addDaysIso(today, -RECONCILE_LOOKBACK_DAYS),
      today,
    );
    const matches = matchPaidBillOccurrences(
      cashBills.map((b) => ({
        id: b.id,
        name: b.name,
        amountCents: b.amountCents,
        intervalMonths: b.intervalMonths,
        anchorDate: b.anchorDate,
        overridesByDate: new Map(
          (billOverridesByBill.get(b.id) ?? []).map((o) => [o.date, o.amountCents] as const),
        ),
      })),
      recentDrafts,
    );
    const billNameById = new Map(cashBills.map((b) => [b.id, b.name] as const));
    for (const m of matches) {
      const list = paidOccurrencesByBill.get(m.billId) ?? [];
      list.push({ date: m.occurrenceDate, paidAmountCents: m.paidAmountCents });
      paidOccurrencesByBill.set(m.billId, list);
      for (const draftId of m.draftIds) {
        billMatchesByDraftId[draftId] = {
          billId: m.billId,
          billName: billNameById.get(m.billId) ?? "Bill",
          occurrenceDate: m.occurrenceDate,
        };
      }
    }
  }
  // Each draft on date D subtracts amountCents from the running balance
  // (positive = expense, negative = refund flows to income). To make a
  // forward walk land at liveBalance on `today`, seed the start-of-startDate
  // balance with liveBalance + Σ amountCents — the walk subtracts that sum
  // off as it crosses the historical window, leaving liveBalance at today.
  const historicalDeltaSum = historicalDrafts.reduce((sum, d) => sum + d.amountCents, 0);
  const effectiveStartingBalance = lookback
    ? (linkedBalance as number) + historicalDeltaSum
    : (linkedBalance ?? settings.startingBalanceCents);

  // Only consider scheduled events on/after startDate, except in lookback
  // mode where past events render as zero-amount "paid" markers via the
  // settledBeforeDate mechanism (and would otherwise be filtered out here).
  const onOrAfterStart = (iso: string) => lookback || iso >= startDate;
  // Settle-before pivot:
  //   - Manual mode: the as-of date — the balance is taken on that date, so
  //     anything strictly before it is already inside it.
  //   - Linked + lookback: tomorrow. The live balance reflects everything that
  //     posted through today, including today's drafts; today's scheduled
  //     events (which would otherwise double-count with drafts) become paid
  //     markers, and the projection's first "live" cash-impact row is
  //     tomorrow.
  //   - Linked, no lookback: today. There are no past rows to render anyway.
  const settleBefore = lookback ? addDaysIso(today, 1) : linked ? today : startDate;

  // Shared markers for all credit-card-derived extras: they need to be
  // settled-before-today in lookback mode so past-dated cycles don't
  // re-debit the running balance (the live Plaid balance already reflects
  // any payment that actually cleared).
  const decorateScheduledExtra = <T extends OneTimeExpense>(e: T): T =>
    lookback
      ? { ...e, settledBeforeDate: settleBefore, showSettledBeforeDate: true }
      : e;

  const historicalExtras: OneTimeExpense[] = historicalDrafts.map((d) => ({
    date: d.date,
    description: d.merchantName ?? d.description,
    amountCents: d.amountCents,
  }));

  const input: ProjectionInput = {
    startingBalanceCents: effectiveStartingBalance,
    startDate,
    endDate,
    paychecks: paychecks
      .filter((p) => onOrAfterStart(p.payDate))
      .map((p) => ({
        payDate: p.payDate,
        amountCents: p.actualReceived && p.actualAmountCents != null ? p.actualAmountCents : p.amountCents,
        note: p.note,
        settledBeforeDate: settleBefore,
        showSettledBeforeDate: lookback,
      })),
    bills: cashBills.map((b) => ({
      id: b.id,
      name: b.name,
      amountCents: b.amountCents,
      intervalMonths: b.intervalMonths,
      anchorDate: b.anchorDate,
      paymentOverrides: billOverridesByBill.get(b.id) ?? [],
      paidOccurrences: paidOccurrencesByBill.get(b.id) ?? [],
      settledBeforeDate: settleBefore,
      showSettledBeforeDate: lookback || (linked && b.autoPay),
    })),
    extras: [
      ...extras
        .filter((e) => onOrAfterStart(e.date))
        .filter((e) => e.paidViaCardId == null || !activeCardIds.has(e.paidViaCardId))
        .map((e) => ({
          date: e.date,
          description: e.description,
          amountCents: e.amountCents,
          settledBeforeDate: settleBefore,
          showSettledBeforeDate: lookback,
        })),
      ...cardPayments.extras.filter((e) => onOrAfterStart(e.date)).map(decorateScheduledExtra),
      ...historicalExtras,
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
    promoDriftByCard: cardPayments.promoDriftByCard,
    variableBillCategoriesByKey: cardPayments.variableBillCategoriesByKey,
    billMatchesByDraftId,
  };
}
