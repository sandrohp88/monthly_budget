"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { Toaster } from "sonner";
import { CurrencyProvider } from "@/components/currency-provider";
import { ThemeToggle } from "@/components/theme-toggle";

const ROUTE_TO_CRUMB: Record<string, string> = {
  "/": "DASHBOARD",
  "/bills": "BILLS",
  "/accounts": "ACCOUNTS",
  "/transactions": "TRANSACTIONS",
  "/credit-cards": "CREDIT CARDS",
  "/paychecks": "PAYCHECKS",
  "/extras": "ONE-TIME",
  "/projection": "PROJECTION",
  "/settings": "SETTINGS",
};

export function AppShell({
  currency,
  displayName,
  role = "OWNER",
  children,
}: {
  currency: string;
  displayName: string;
  role?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "/";
  const crumb = ROUTE_TO_CRUMB[pathname] ?? "ROOT";

  return (
    <CurrencyProvider currency={currency}>
      <div
        data-app-shell
        className="flex h-screen w-screen overflow-hidden bg-[var(--bg-0)] text-[var(--text-0)]"
      >
        <Sidebar displayName={displayName} role={role} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header
            className="sticky top-0 z-10 flex h-[60px] shrink-0 items-center justify-between border-b border-[var(--border-raw)] px-9 backdrop-blur-md"
            style={{ background: "var(--header-glass)" }}
          >
            <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-2)]">
              SYS <span className="text-[var(--text-3)] mx-2">/</span>
              ROOT <span className="text-[var(--text-3)] mx-2">/</span>
              <span className="text-[var(--mint)]">{crumb}</span>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-2)]">
                <span className="text-[var(--text-3)]">USER</span>{" "}
                <span className="text-[var(--text-1)]">{displayName}</span>
                <span className="mx-2 text-[var(--text-3)]">/</span>
                <span className="text-[var(--mint)]">{role}</span>
              </div>
              <ThemeToggle />
            </div>
          </header>
          <main className="min-h-0 flex-1 overflow-auto px-9 pb-16 pt-7">{children}</main>
        </div>
      </div>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: "var(--bg-1)",
            color: "var(--text-0)",
            border: "1px solid var(--border-2)",
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            letterSpacing: "0.05em",
          },
        }}
      />
    </CurrencyProvider>
  );
}
