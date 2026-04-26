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
              <stop offset="0%" stopColor="#5dffa0" stopOpacity={0.28} />
              <stop offset="100%" stopColor="#5dffa0" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 4" stroke="#1f2a22" />
          <XAxis
            dataKey="date"
            minTickGap={32}
            tick={{ fontSize: 9, fill: "#4a5650", fontFamily: "var(--font-mono)" }}
            stroke="#2a3a2e"
            tickFormatter={(v: string) => v.slice(5)}
          />
          <YAxis
            tickFormatter={(v: number) => formatCents(Math.round(v * 100), currency)}
            tick={{ fontSize: 9, fill: "#4a5650", fontFamily: "var(--font-mono)" }}
            width={80}
            stroke="#2a3a2e"
          />
          <Tooltip
            formatter={(v: number) => formatCents(Math.round(v * 100), currency)}
            labelStyle={{ color: "#b8c5bc", fontSize: 10, fontFamily: "var(--font-mono)" }}
            itemStyle={{ color: "#5dffa0", fontFamily: "var(--font-mono)", fontSize: 11 }}
            contentStyle={{
              background: "#0d1310",
              border: "1px solid #2a3a2e",
              borderRadius: 3,
              fontFamily: "var(--font-mono)",
            }}
          />
          <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="4 4" />
          <Area
            type="monotone"
            dataKey="balance"
            stroke="#4ade80"
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
