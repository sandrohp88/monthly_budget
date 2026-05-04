"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceLine,
} from "recharts";
import { formatCents } from "@/lib/money";
import { useCurrency } from "@/components/currency-provider";

type Point = { date: string; balanceCents: number };

export function ProjectionChart({ data }: { data: ReadonlyArray<Point> }) {
  const currency = useCurrency();
  const formatted = React.useMemo(
    () => data.map((d) => ({ date: d.date, balance: d.balanceCents / 100 })),
    [data],
  );

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <AreaChart data={formatted} margin={{ top: 12, right: 16, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="mintArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-fill)" stopOpacity={1} />
              <stop offset="100%" stopColor="var(--chart-fill)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 4" stroke="var(--chart-grid)" />
          <XAxis
            dataKey="date"
            minTickGap={32}
            tick={{ fontSize: 10, fill: "var(--chart-axis)", fontFamily: "var(--font-mono)" }}
            stroke="var(--chart-grid)"
            tickFormatter={(v: string) => v.slice(5)}
          />
          <YAxis
            tickFormatter={(v: number) => formatCents(Math.round(v * 100), currency)}
            tick={{ fontSize: 10, fill: "var(--chart-axis)", fontFamily: "var(--font-mono)" }}
            width={80}
            stroke="var(--chart-grid)"
          />
          <Tooltip
            formatter={(v: number) => formatCents(Math.round(v * 100), currency)}
            labelStyle={{ color: "var(--text-2)", fontSize: 11, fontFamily: "var(--font-mono)" }}
            itemStyle={{ color: "var(--chart-line)", fontFamily: "var(--font-mono)", fontSize: 12 }}
            contentStyle={{
              background: "var(--chart-tooltip-bg)",
              border: "1px solid var(--border-2)",
              borderRadius: 6,
              fontFamily: "var(--font-mono)",
            }}
          />
          <ReferenceLine y={0} stroke="var(--red)" strokeDasharray="4 4" />
          <Area
            type="monotone"
            dataKey="balance"
            stroke="var(--chart-line)"
            strokeWidth={2}
            fill="url(#mintArea)"
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
