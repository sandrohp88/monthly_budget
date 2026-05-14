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
import { useTheme } from "next-themes";
import { formatCents } from "@/lib/money";
import { useCurrency } from "@/components/currency-provider";

type Point = { date: string; balanceCents: number };

type ChartTokens = {
  cyan: string;
  cyanGlow: string;
  red: string;
  borderRaw: string;
  border2: string;
  text1: string;
  text3: string;
  bg1: string;
};

const FALLBACK_TOKENS: ChartTokens = {
  cyan: "#00E5FF",
  cyanGlow: "rgba(0, 229, 255, 0.35)",
  red: "#FF1744",
  borderRaw: "#1F2B38",
  border2: "#2A3E54",
  text1: "#B8C5D2",
  text3: "#4A5C6E",
  bg1: "#0E1318",
};

/**
 * Read the resolved values of the theme CSS variables off the document
 * element. Returns fallback dark-theme hexes when running on the server or
 * before hydration. Recharts can't accept CSS var strings (it draws to an
 * SVG that doesn't inherit the cascade for some props), so we resolve
 * them once per theme change.
 */
function readChartTokens(): ChartTokens {
  if (typeof window === "undefined") return FALLBACK_TOKENS;
  const cs = window.getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    const v = cs.getPropertyValue(name).trim();
    return v.length > 0 ? v : fallback;
  };
  return {
    cyan: read("--cyan", FALLBACK_TOKENS.cyan),
    cyanGlow: read("--cyan-glow", FALLBACK_TOKENS.cyanGlow),
    red: read("--red", FALLBACK_TOKENS.red),
    borderRaw: read("--border-raw", FALLBACK_TOKENS.borderRaw),
    border2: read("--border-2", FALLBACK_TOKENS.border2),
    text1: read("--text-1", FALLBACK_TOKENS.text1),
    text3: read("--text-3", FALLBACK_TOKENS.text3),
    bg1: read("--bg-1", FALLBACK_TOKENS.bg1),
  };
}

export function ProjectionChart({ data }: { data: ReadonlyArray<Point> }) {
  const currency = useCurrency();
  // useTheme triggers a re-render on theme change; we don't read its
  // value directly because resolved theme could be "system" → an alias.
  // Reading from getComputedStyle picks up whichever data-theme is live.
  const { theme, resolvedTheme } = useTheme();
  const themeKey = theme === "system" ? resolvedTheme : theme;
  const [tokens, setTokens] = React.useState<ChartTokens>(FALLBACK_TOKENS);
  React.useEffect(() => {
    setTokens(readChartTokens());
  }, [themeKey]);

  const formatted = React.useMemo(
    () => data.map((d) => ({ date: d.date, balance: d.balanceCents / 100 })),
    [data],
  );

  // Recharts SVG `id` collisions can happen if multiple charts mount on the
  // same page with the same gradient id. Suffix with theme so the gradient
  // refreshes when colors change.
  const gradientId = `chart-area-${themeKey ?? "default"}`;

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <AreaChart data={formatted} margin={{ top: 12, right: 16, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={tokens.cyan} stopOpacity={0.28} />
              <stop offset="100%" stopColor={tokens.cyan} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 4" stroke={tokens.borderRaw} />
          <XAxis
            dataKey="date"
            minTickGap={32}
            tick={{ fontSize: 11, fill: tokens.text3, fontFamily: "var(--font-ui)" }}
            stroke={tokens.border2}
            tickFormatter={(v: string) => v.slice(5)}
          />
          <YAxis
            tickFormatter={(v: number) => formatCents(Math.round(v * 100), currency)}
            tick={{ fontSize: 11, fill: tokens.text3, fontFamily: "var(--font-ui)" }}
            width={80}
            stroke={tokens.border2}
          />
          <Tooltip
            formatter={(v: number) => formatCents(Math.round(v * 100), currency)}
            labelStyle={{ color: tokens.text1, fontSize: 12, fontFamily: "var(--font-ui)" }}
            itemStyle={{ color: tokens.cyan, fontFamily: "var(--font-ui)", fontSize: 12 }}
            contentStyle={{
              background: tokens.bg1,
              border: `1px solid ${tokens.border2}`,
              borderRadius: 12,
              fontFamily: "var(--font-ui)",
            }}
          />
          <ReferenceLine y={0} stroke={tokens.red} strokeDasharray="4 4" />
          <Area
            type="monotone"
            dataKey="balance"
            stroke={tokens.cyan}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
