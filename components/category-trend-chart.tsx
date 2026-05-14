"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCents } from "@/lib/money";
import { useCurrency } from "@/components/currency-provider";

type CategoryInfo = { name: string; color: string };

export function CategoryTrendChart({
  data,
  categories,
}: {
  data: Array<Record<string, unknown>>;
  categories: CategoryInfo[];
}) {
  const currency = useCurrency();

  if (data.length === 0 || categories.length === 0) {
    return (
      <div className="py-8 text-center text-[10px] uppercase tracking-[0.15em] text-[var(--text-3)]">
        No data to display
      </div>
    );
  }

  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border-raw)"
            vertical={false}
          />
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
            tickFormatter={(v: number) => formatCents(v, currency)}
          />
          <Tooltip
            contentStyle={{
              background: "var(--bg-2)",
              border: "1px solid var(--border-raw)",
              borderRadius: 0,
              fontSize: 10,
            }}
            labelStyle={{ color: "var(--text-1)", fontWeight: 700, textTransform: "uppercase" }}
            formatter={(value: number, name: string) => [formatCents(value, currency), name]}
          />
          {categories.map((cat) => (
            <Bar
              key={cat.name}
              dataKey={cat.name}
              stackId="spend"
              fill={cat.color}
              radius={0}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
