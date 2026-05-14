"use client";

import * as React from "react";

function formatNow(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}` +
    ` · ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
}

export function UtcClock() {
  const [now, setNow] = React.useState<string | null>(null);

  React.useEffect(() => {
    setNow(formatNow());
    const id = window.setInterval(() => setNow(formatNow()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <span
      className="text-[12px] tabular-nums text-[var(--text-3)]"
      suppressHydrationWarning
    >
      {now ?? "0000.00.00 · 00:00:00 UTC"}
    </span>
  );
}
