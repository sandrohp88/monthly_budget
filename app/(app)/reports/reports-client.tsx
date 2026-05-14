"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CardSubTag } from "@/components/ui/page-head";
import { Tile, TileGrid } from "@/components/ui/tile";
import { Money } from "@/components/money";
import { CategoryTrendChart } from "@/components/category-trend-chart";
import { cn } from "@/lib/cn";

type TabKey = "TRENDS" | "YTD" | "CATEGORIES";

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "TRENDS", label: "CATEGORY TRENDS" },
  { key: "YTD", label: "YTD SUMMARY" },
  { key: "CATEGORIES", label: "BY CATEGORY" },
];

type CategoryInfo = { name: string; color: string };
type CategoryTotal = { name: string; color: string; totalCents: number };
type ExtraItem = { date: string; description: string; amountCents: number; category: string };
type BillItem = { name: string; amountCents: number; intervalMonths: number; category: string };
type NetWorthData = {
  assetsCents: number;
  depositoryBalanceCents: number;
  creditCardDebtCents: number;
  promoDebtCents: number;
  netWorthCents: number;
};

export function ReportsClient({
  today,
  currentYear,
  ytdIncomeCents,
  ytdExpenseCents,
  ytdMonthsElapsed,
  trendData,
  trendMonths,
  expenseCategories,
  categoryTotals,
  extras,
  bills,
  netWorth,
}: {
  today: string;
  currentYear: string;
  ytdIncomeCents: number;
  ytdExpenseCents: number;
  ytdMonthsElapsed: number;
  trendData: Array<Record<string, unknown>>;
  trendMonths: string[];
  expenseCategories: CategoryInfo[];
  categoryTotals: CategoryTotal[];
  extras: ExtraItem[];
  bills: BillItem[];
  netWorth: NetWorthData;
}) {
  const [tab, setTab] = React.useState<TabKey>("TRENDS");
  const [selectedCategory, setSelectedCategory] = React.useState<string>("all");
  const [dateFrom, setDateFrom] = React.useState(`${currentYear}-01-01`);
  const [dateTo, setDateTo] = React.useState(today);

  const avgMonthlyIncome = ytdMonthsElapsed > 0 ? Math.round(ytdIncomeCents / ytdMonthsElapsed) : 0;
  const avgMonthlyExpense = ytdMonthsElapsed > 0 ? Math.round(ytdExpenseCents / ytdMonthsElapsed) : 0;
  const netYtd = ytdIncomeCents - ytdExpenseCents;

  // Filtered expenses for the category query
  const filteredExpenses = React.useMemo(() => {
    const items: Array<{ date: string; description: string; amountCents: number; category: string }> = [];

    // Extras in range
    for (const e of extras) {
      if (e.date < dateFrom || e.date > dateTo) continue;
      if (selectedCategory !== "all" && e.category !== selectedCategory) continue;
      items.push(e);
    }

    items.sort((a, b) => b.date.localeCompare(a.date));
    return items;
  }, [extras, selectedCategory, dateFrom, dateTo]);

  const filteredBills = React.useMemo(() => {
    if (selectedCategory === "all") return bills;
    return bills.filter((b) => b.category === selectedCategory);
  }, [bills, selectedCategory]);

  const filteredMonthlyBillTotal = filteredBills.reduce(
    (sum, b) => sum + Math.round(b.amountCents / b.intervalMonths),
    0,
  );

  return (
    <>
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-[var(--border-raw)]">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "px-4 py-2.5 text-[10px] uppercase tracking-[0.15em] font-semibold transition-colors",
              tab === t.key
                ? "text-[var(--cyan)] border-b-2 border-[var(--cyan)]"
                : "text-[var(--text-2)] hover:text-[var(--text-0)]",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* TRENDS tab */}
      {tab === "TRENDS" && (
        <Card>
          <CardHeader>
            <div>
              <CardSubTag>CHART_02</CardSubTag>
              <CardTitle className="mt-0.5">6-MONTH CATEGORY SPEND</CardTitle>
            </div>
            <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]">
              {trendMonths[0]} – {trendMonths[trendMonths.length - 1]}
            </div>
          </CardHeader>
          <CardContent>
            {expenseCategories.length === 0 ? (
              <div className="py-8 text-center text-[10px] uppercase tracking-[0.15em] text-[var(--text-3)]">
                No expense categories defined
              </div>
            ) : (
              <CategoryTrendChart
                data={trendData}
                categories={expenseCategories}
              />
            )}
          </CardContent>
        </Card>
      )}

      {/* YTD tab */}
      {tab === "YTD" && (
        <div className="space-y-5">
          <TileGrid cols={4}>
            <Tile
              label="YTD INCOME"
              value={<Money cents={ytdIncomeCents} />}
              variant="mint"
              delta={`avg ${formatDollars(avgMonthlyIncome)}/mo`}
            />
            <Tile
              label="YTD EXPENSES"
              value={<Money cents={ytdExpenseCents} />}
              delta={`avg ${formatDollars(avgMonthlyExpense)}/mo`}
            />
            <Tile
              label="YTD NET"
              value={<Money cents={netYtd} />}
              variant={netYtd > 0 ? "mint" : "red"}
              delta={`${currentYear} · ${ytdMonthsElapsed} months`}
            />
            <Tile
              label="NET WORTH"
              value={<Money cents={netWorth.netWorthCents} />}
              variant={netWorth.netWorthCents >= 0 ? "mint" : "red"}
              delta={`assets ${formatDollars(netWorth.assetsCents)} · debt ${formatDollars(netWorth.creditCardDebtCents + netWorth.promoDebtCents)}`}
            />
          </TileGrid>

          <Card>
            <CardHeader>
              <div>
                <CardSubTag>COMPARE_01</CardSubTag>
                <CardTitle className="mt-0.5">INCOME vs EXPENSE</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <BarCompare label="INCOME" cents={ytdIncomeCents} max={Math.max(ytdIncomeCents, ytdExpenseCents)} color="var(--cyan)" />
                <BarCompare label="EXPENSE" cents={ytdExpenseCents} max={Math.max(ytdIncomeCents, ytdExpenseCents)} color="var(--red)" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardSubTag>NET_WORTH</CardSubTag>
                <CardTitle className="mt-0.5">NET WORTH BREAKDOWN</CardTitle>
              </div>
              <div className="tabular text-[15px] font-bold" style={{ color: netWorth.netWorthCents >= 0 ? "var(--cyan)" : "var(--red)" }}>
                <Money cents={netWorth.netWorthCents} />
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <BarCompare label="ASSETS" cents={netWorth.assetsCents} max={Math.max(netWorth.assetsCents, netWorth.depositoryBalanceCents, netWorth.creditCardDebtCents + netWorth.promoDebtCents)} color="var(--cyan)" />
                <BarCompare label="BANK DEPOSITS" cents={netWorth.depositoryBalanceCents} max={Math.max(netWorth.assetsCents, netWorth.depositoryBalanceCents, netWorth.creditCardDebtCents + netWorth.promoDebtCents)} color="var(--phosphor)" />
                <BarCompare label="CREDIT CARD DEBT" cents={netWorth.creditCardDebtCents} max={Math.max(netWorth.assetsCents, netWorth.depositoryBalanceCents, netWorth.creditCardDebtCents + netWorth.promoDebtCents)} color="var(--red)" />
                {netWorth.promoDebtCents > 0 && (
                  <BarCompare label="PROMO BALANCES" cents={netWorth.promoDebtCents} max={Math.max(netWorth.assetsCents, netWorth.depositoryBalanceCents, netWorth.creditCardDebtCents + netWorth.promoDebtCents)} color="var(--amber)" />
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* CATEGORIES tab */}
      {tab === "CATEGORIES" && (
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <div>
                <CardSubTag>FILTER_01</CardSubTag>
                <CardTitle className="mt-0.5">CATEGORY QUERY</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <label className="mb-1 block text-[9px] uppercase tracking-[0.15em] text-[var(--text-3)]">
                    CATEGORY
                  </label>
                  <select
                    value={selectedCategory}
                    onChange={(e) => setSelectedCategory(e.target.value)}
                    className="h-8 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 text-[11px] text-[var(--text-0)] uppercase tracking-[0.08em] focus:border-[var(--cyan)] focus:outline-none"
                  >
                    <option value="all">ALL CATEGORIES</option>
                    {expenseCategories.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[9px] uppercase tracking-[0.15em] text-[var(--text-3)]">
                    FROM
                  </label>
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="h-8 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 text-[11px] text-[var(--text-0)] tabular focus:border-[var(--cyan)] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[9px] uppercase tracking-[0.15em] text-[var(--text-3)]">
                    TO
                  </label>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="h-8 rounded-sm border border-[var(--border-raw)] bg-[var(--bg-2)] px-3 text-[11px] text-[var(--text-0)] tabular focus:border-[var(--cyan)] focus:outline-none"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Monthly recurring for the selected category */}
          {filteredBills.length > 0 && (
            <Card>
              <CardHeader>
                <div>
                  <CardSubTag>RECURRING</CardSubTag>
                  <CardTitle className="mt-0.5">MONTHLY RECURRING</CardTitle>
                </div>
                <div className="tabular text-[11px] font-bold text-[var(--text-0)]">
                  <Money cents={filteredMonthlyBillTotal} />/mo
                </div>
              </CardHeader>
              <div className="divide-y divide-[var(--border-raw)]">
                {filteredBills.map((b) => (
                  <div
                    key={b.name}
                    className="flex items-center justify-between px-5 py-2.5"
                  >
                    <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-1)]">
                      {b.name}
                    </span>
                    <span className="tabular text-[11px] text-[var(--text-0)]">
                      <Money cents={Math.round(b.amountCents / b.intervalMonths)} />
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* One-time expenses list */}
          <Card>
            <CardHeader>
              <div>
                <CardSubTag>TABLE_02</CardSubTag>
                <CardTitle className="mt-0.5">ONE-TIME EXPENSES</CardTitle>
              </div>
              <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]">
                {filteredExpenses.length} items · <Money cents={filteredExpenses.reduce((s, e) => s + e.amountCents, 0)} />
              </div>
            </CardHeader>
            {filteredExpenses.length === 0 ? (
              <div className="px-5 py-6 text-center text-[10px] uppercase tracking-[0.15em] text-[var(--text-3)]">
                No expenses match the current filter
              </div>
            ) : (
              <div className="max-h-[400px] overflow-y-auto divide-y divide-[var(--border-raw)]">
                {filteredExpenses.map((e, i) => (
                  <div
                    key={`${e.date}-${e.description}-${i}`}
                    className="flex items-center justify-between px-5 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[11px] text-[var(--text-0)]">
                        {e.description}
                      </div>
                      <div className="mt-0.5 text-[9px] uppercase tracking-[0.12em] text-[var(--text-3)]">
                        {e.date} · {e.category}
                      </div>
                    </div>
                    <span className="tabular text-[11px] font-bold text-[var(--text-0)]">
                      <Money cents={e.amountCents} />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Category totals */}
          <Card>
            <CardHeader>
              <div>
                <CardSubTag>TOTALS</CardSubTag>
                <CardTitle className="mt-0.5">ANNUALIZED BY CATEGORY</CardTitle>
              </div>
            </CardHeader>
            <div className="divide-y divide-[var(--border-raw)]">
              {categoryTotals
                .filter((c) => c.totalCents > 0)
                .sort((a, b) => b.totalCents - a.totalCents)
                .map((c) => (
                  <div
                    key={c.name}
                    className="flex items-center justify-between px-5 py-2.5"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={{ backgroundColor: c.color }}
                      />
                      <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-1)]">
                        {c.name}
                      </span>
                    </div>
                    <span className="tabular text-[11px] font-bold text-[var(--text-0)]">
                      <Money cents={c.totalCents} />
                    </span>
                  </div>
                ))}
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

function BarCompare({
  label,
  cents,
  max,
  color,
}: {
  label: string;
  cents: number;
  max: number;
  color: string;
}) {
  const pct = max > 0 ? (cents / max) * 100 : 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-2)]">
          {label}
        </span>
        <span className="tabular text-[11px] font-bold" style={{ color }}>
          <Money cents={cents} />
        </span>
      </div>
      <div className="h-2 w-full bg-[var(--bg-2)]">
        <div
          className="h-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

function formatDollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString()}`;
}
