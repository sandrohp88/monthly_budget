import "server-only";
import { addDaysIso, todayIso } from "./dates";
import {
  getSettings,
  listBills,
  listExtras,
  listPaychecks,
  listStatementsForUser,
} from "./repos";
import { computeProjection, type ProjectionInput, type ProjectionRow } from "./projection";

export type ProjectionBundle = {
  rows: ProjectionRow[];
  startDate: string;
  endDate: string;
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

  const [bills, paychecks, extras, statements] = await Promise.all([
    listBills(userId, false),
    listPaychecks(userId),
    listExtras(userId),
    listStatementsForUser(userId),
  ]);

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

  const input: ProjectionInput = {
    startingBalanceCents: settings.startingBalanceCents,
    startDate,
    endDate,
    paychecks: paychecks.map((p) => ({
      payDate: p.payDate,
      amountCents: p.actualReceived && p.actualAmountCents != null ? p.actualAmountCents : p.amountCents,
      note: p.note,
    })),
    bills: bills.map((b) => ({
      id: b.id,
      name: b.name,
      amountCents: b.amountCents,
      frequency: b.frequency,
      dueDay: b.dueDay,
      dueMonth: b.dueMonth,
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
    startingBalanceCents: settings.startingBalanceCents,
    projectionMonths: settings.projectionMonths,
    currency: settings.currency,
  };
}
