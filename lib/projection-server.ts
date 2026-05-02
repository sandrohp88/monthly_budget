import "server-only";
import { addDaysIso, todayIso } from "./dates";
import {
  getSettings,
  listBills,
  listCreditCards,
  listExtras,
  listPaychecks,
  listStatementsForUser,
  getPrimaryLinkedBalance,
} from "./repos";
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

  const [bills, paychecks, extras, statements, activeCards, linkedBalance] = await Promise.all([
    listBills(userId, false),
    listPaychecks(userId),
    listExtras(userId),
    listStatementsForUser(userId),
    listCreditCards(userId, false),
    getPrimaryLinkedBalance(userId),
  ]);
  const activeCardIds = new Set(activeCards.map((c) => c.id));

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
    })),
    extras: [
      ...extras.map((e) => ({
        date: e.date,
        description: e.description,
        amountCents: e.amountCents,
      })),
      ...ccExtras,
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
