import * as React from "react";

/**
 * Tiny SVG sparkline. Theme-aware via CSS vars — `stroke` defaults to the
 * primary cyan, with a soft area-fill gradient underneath. Use it as a
 * preview alongside a headline number; for full-blown axes/tooltips reach
 * for `ProjectionChart` instead.
 *
 * Pass an array of numeric values. The component normalizes them to the
 * viewBox so the absolute scale doesn't matter — only the shape.
 */
export function Sparkline({
  data,
  width = "100%",
  height = 40,
  stroke = "var(--cyan)",
  fill = true,
  dot = true,
  strokeWidth = 1.4,
  className,
}: {
  data: ReadonlyArray<number>;
  width?: number | string;
  height?: number;
  stroke?: string;
  fill?: boolean;
  dot?: boolean;
  strokeWidth?: number;
  className?: string;
}) {
  const gradientId = React.useId();
  if (data.length < 2) {
    return <div style={{ width, height }} className={className} />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => ({
    x: (i / (data.length - 1)) * 100,
    y: 100 - ((v - min) / range) * 100,
  }));
  const path = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const fillPath = `${path} L100,100 L0,100 Z`;
  const last = pts[pts.length - 1]!;

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      width={width}
      height={height}
      className={className}
      style={{ display: "block", overflow: "visible" }}
      aria-hidden
    >
      {fill ? (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={fillPath} fill={`url(#${gradientId})`} />
        </>
      ) : null}
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        vectorEffect="non-scaling-stroke"
      />
      {dot ? (
        <circle
          cx={last.x}
          cy={last.y}
          r={1.8}
          fill={stroke}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}
