"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCents } from "@/lib/money";
import { useCurrency } from "@/components/currency-provider";

export type CardForecastSeries = { cardId: string; cardName: string; color: string };

/**
 * Stacked monthly card obligations — one stack segment per card. Fed by
 * `buildCardForecast`, so the bars are the same numbers the ledger projects.
 */
export function CardForecastChart({
  data,
  series,
}: {
  /** One row per month: `{ month: "Aug", [cardId]: cents, ... }`. */
  data: Array<Record<string, string | number>>;
  series: CardForecastSeries[];
}) {
  const currency = useCurrency();

  if (data.length === 0 || series.length === 0) {
    return (
      <div className="py-8 text-center text-2xs text-[var(--text-3)]">Nothing due in this window</div>
    );
  }

  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-raw)" vertical={false} />
          <XAxis
            dataKey="month"
            tick={{ fontSize: 9, fill: "var(--text-3)" }}
            tickLine={false}
            axisLine={{ stroke: "var(--border-raw)" }}
          />
          <YAxis
            tick={{ fontSize: 9, fill: "var(--text-3)" }}
            tickLine={false}
            axisLine={false}
            width={70}
            tickFormatter={(v: number) => formatCents(v, currency)}
          />
          <Tooltip
            cursor={{ fill: "var(--bg-2)" }}
            contentStyle={{
              background: "var(--bg-2)",
              border: "1px solid var(--border-raw)",
              borderRadius: 0,
              fontSize: 10,
            }}
            labelStyle={{ color: "var(--text-1)", fontWeight: 700 }}
            formatter={(value: number, name: string) => [formatCents(value, currency), name]}
          />
          <Legend
            wrapperStyle={{ fontSize: 10, color: "var(--text-2)", paddingTop: 4 }}
            iconType="square"
            iconSize={8}
          />
          {series.map((s) => (
            <Bar
              key={s.cardId}
              dataKey={s.cardId}
              name={s.cardName}
              stackId="due"
              fill={s.color}
              radius={0}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
