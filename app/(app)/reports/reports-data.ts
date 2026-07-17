import "server-only";
import type { ComponentProps } from "react";
import {
  listBills,
  listExtras,
  listCategories,
  listPaychecks,
  getNetWorthComponents,
  getSettings,
} from "@/lib/repos";
import { DEFAULT_TIMEZONE, todayIso } from "@/lib/dates";
import type { ReportsClient } from "./reports-client";

type ReportsClientProps = ComponentProps<typeof ReportsClient>;

/**
 * Assemble everything the Reports view renders. Extracted from the old
 * /reports page so the Ledger page (which now hosts Reports as a tab) can
 * fetch it alongside the projection bundle.
 */
export async function buildReportsData(userId: string): Promise<ReportsClientProps> {
  const settings = await getSettings(userId);
  const today = todayIso(settings?.timezone ?? DEFAULT_TIMEZONE);
  const currentYear = today.slice(0, 4);
  const yearStart = `${currentYear}-01-01`;

  const [bills, extras, categories, paychecks, netWorth] = await Promise.all([
    listBills(userId, false),
    listExtras(userId),
    listCategories(userId),
    listPaychecks(userId),
    getNetWorthComponents(userId),
  ]);

  // YTD income: sum of paychecks with payDate in current year
  const ytdIncomeCents = paychecks
    .filter((p) => p.payDate >= yearStart && p.payDate <= today)
    .reduce((sum, p) => sum + p.amountCents, 0);

  // YTD expenses: monthly bills amortized + one-time expenses in year
  const ytdMonthsElapsed = Number(today.slice(5, 7));
  const ytdBillsCents = bills.reduce((sum, b) => {
    const monthlyAmount = Math.round(b.amountCents / b.intervalMonths);
    return sum + monthlyAmount * ytdMonthsElapsed;
  }, 0);
  const ytdExtrasCents = extras
    .filter((e) => e.date >= yearStart && e.date <= today)
    .reduce((sum, e) => sum + e.amountCents, 0);
  const ytdExpenseCents = ytdBillsCents + ytdExtrasCents;

  // Build 6-month category spend data for trend chart
  const monthKeys: string[] = [];
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  for (let i = 5; i >= 0; i--) {
    const total = y * 12 + (m - 1) - i;
    const my = Math.floor(total / 12);
    const mm = (total % 12) + 1;
    monthKeys.push(`${my}-${String(mm).padStart(2, "0")}`);
  }

  // Category breakdown per month (bills amortized + extras)
  const expenseCategories = categories.filter((c) => c.kind === "expense");
  const trendData: Array<Record<string, unknown>> = monthKeys.map((mk) => {
    const row: Record<string, number | string> = {};
    row.month = mk;
    // Bills contribute their monthly amortized amount in every month
    for (const b of bills) {
      const cat = b.category;
      const monthlyAmt = Math.round(b.amountCents / b.intervalMonths);
      row[cat] = ((row[cat] as number) || 0) + monthlyAmt;
    }
    // Extras in this specific month
    const monthStart = `${mk}-01`;
    const [ey, em] = mk.split("-").map(Number);
    const nextMonth = em === 12 ? `${ey! + 1}-01` : `${ey}-${String(em! + 1).padStart(2, "0")}`;
    const monthEnd = `${nextMonth}-01`;
    for (const e of extras) {
      if (e.date >= monthStart && e.date < monthEnd) {
        row[e.category] = ((row[e.category] as number) || 0) + e.amountCents;
      }
    }
    return row;
  });

  // Category totals for the query section (all-time)
  const categoryTotals: Array<{ name: string; color: string; totalCents: number }> =
    expenseCategories.map((c) => {
      const billTotal = bills
        .filter((b) => b.category === c.name)
        .reduce((sum, b) => sum + Math.round((b.amountCents / b.intervalMonths) * 12), 0);
      const extraTotal = extras
        .filter((e) => e.category === c.name)
        .reduce((sum, e) => sum + e.amountCents, 0);
      return { name: c.name, color: c.color, totalCents: billTotal + extraTotal };
    });

  return {
    today,
    currentYear,
    ytdIncomeCents,
    ytdExpenseCents,
    ytdMonthsElapsed,
    trendData,
    trendMonths: monthKeys,
    expenseCategories: expenseCategories.map((c) => ({ name: c.name, color: c.color })),
    categoryTotals,
    extras: extras.map((e) => ({
      date: e.date,
      description: e.description,
      amountCents: e.amountCents,
      category: e.category,
    })),
    bills: bills.map((b) => ({
      name: b.name,
      amountCents: b.amountCents,
      intervalMonths: b.intervalMonths,
      category: b.category,
    })),
    netWorth,
  };
}
