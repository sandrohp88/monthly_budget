"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

export type LedgerTab = "ledger" | "reports";

/**
 * Segmented switch between the ledger table/insights and the reports
 * analytics. Inactive tab unmounts (charts re-measure cleanly on return).
 */
export function LedgerTabs({
  initialTab,
  ledger,
  reports,
}: {
  initialTab: LedgerTab;
  ledger: React.ReactNode;
  reports: React.ReactNode;
}) {
  const [tab, setTab] = React.useState<LedgerTab>(initialTab);

  const button = (id: LedgerTab, label: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      className={cn(
        "cursor-pointer rounded-full border px-4 py-1.5 text-[12px] font-semibold transition-colors",
        tab === id
          ? "border-[var(--mint)] bg-[var(--mint-glow)] text-[var(--mint)]"
          : "border-[var(--border-raw)] text-[var(--text-2)] hover:border-[var(--border-2)] hover:text-[var(--text-0)]",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        {button("ledger", "Ledger")}
        {button("reports", "Reports")}
      </div>
      {tab === "ledger" ? ledger : reports}
    </div>
  );
}
