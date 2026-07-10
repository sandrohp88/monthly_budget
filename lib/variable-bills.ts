import {
  dueDateFromStatement,
  nextStatementDateOnOrAfter,
} from "./credit-cards";
import { computeProjection } from "./projection";
import type { CreditCardRow, VariableBillRow } from "./db/schema";

export type VariableBillWithCards = VariableBillRow & { cardIds: string[] };

export type VariableBillCardCharge = {
  variableBillId: string;
  cardId: string;
  name: string;
  category: string;
  date: string;
  dueDate: string;
  amountCents: number;
};

function splitEvenly(amountCents: number, buckets: number): number[] {
  if (buckets <= 0) return [];
  const base = Math.floor(amountCents / buckets);
  const remainder = amountCents - base * buckets;
  return Array.from({ length: buckets }, (_, index) => base + (index < remainder ? 1 : 0));
}

export function projectVariableBillCardCharges(opts: {
  variableBills: ReadonlyArray<VariableBillWithCards>;
  cards: ReadonlyArray<CreditCardRow>;
  startDate: string;
  endDate: string;
}): VariableBillCardCharge[] {
  const cardById = new Map(opts.cards.filter((c) => c.isActive).map((c) => [c.id, c]));
  const billsWithCards = opts.variableBills
    .filter((b) => b.isActive)
    .map((bill) => ({
      bill,
      cards: bill.cardIds.map((id) => cardById.get(id)).filter((c): c is CreditCardRow => !!c),
    }))
    .filter(({ cards }) => cards.length > 0);

  if (billsWithCards.length === 0) return [];

  const rows = computeProjection({
    startingBalanceCents: 0,
    startDate: opts.startDate,
    endDate: opts.endDate,
    paychecks: [],
    extras: [],
    bills: billsWithCards.map(({ bill }) => ({
      id: bill.id,
      name: bill.name,
      amountCents: bill.amountCents,
      intervalMonths: bill.intervalMonths,
      anchorDate: bill.anchorDate,
    })),
  });

  const byBillId = new Map(billsWithCards.map((entry) => [entry.bill.id, entry]));
  const charges: VariableBillCardCharge[] = [];
  for (const row of rows) {
    for (const event of row.events) {
      if (event.kind !== "bill" || !event.sourceId) continue;
      const entry = byBillId.get(event.sourceId);
      if (!entry) continue;
      const amounts = splitEvenly(event.amountCents, entry.cards.length);
      entry.cards.forEach((card, index) => {
        const amountCents = amounts[index] ?? 0;
        if (amountCents <= 0) return;
        const statementDate = nextStatementDateOnOrAfter(row.date, card);
        charges.push({
          variableBillId: entry.bill.id,
          cardId: card.id,
          name: entry.bill.name,
          category: entry.bill.category,
          date: row.date,
          dueDate: dueDateFromStatement(statementDate, card.dueDay, card.gracePeriodDays),
          amountCents,
        });
      });
    }
  }
  return charges;
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 + 1 };
}

export function monthKeysThrough(asOfIso: string, months: number): string[] {
  const [year, month] = asOfIso.split("-").map(Number);
  const out: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const m = addMonths(year!, month!, -i);
    out.push(`${String(m.year).padStart(4, "0")}-${String(m.month).padStart(2, "0")}`);
  }
  return out;
}

export function calculateMonthlyHistoryAverage(
  rows: ReadonlyArray<{ date: string; amountCents: number }>,
  asOfIso: string,
  lookbackMonths: number,
): {
  averageCents: number;
  totalCents: number;
  sampleCount: number;
  monthlyTotals: Array<{ month: string; amountCents: number }>;
} {
  const months = monthKeysThrough(asOfIso, lookbackMonths);
  const totals = new Map(months.map((month) => [month, 0]));
  let sampleCount = 0;
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    if (!totals.has(month) || row.amountCents <= 0) continue;
    totals.set(month, totals.get(month)! + row.amountCents);
    sampleCount += 1;
  }
  const monthlyTotals = months.map((month) => ({
    month,
    amountCents: totals.get(month) ?? 0,
  }));
  const totalCents = monthlyTotals.reduce((sum, row) => sum + row.amountCents, 0);
  return {
    averageCents: lookbackMonths > 0 ? Math.round(totalCents / lookbackMonths) : 0,
    totalCents,
    sampleCount,
    monthlyTotals,
  };
}
