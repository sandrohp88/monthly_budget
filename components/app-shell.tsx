"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Sidebar, type SidebarSummary } from "@/components/sidebar";
import { MobileNav } from "@/components/mobile-nav";
import { MobileTabBar } from "@/components/mobile-tab-bar";
import { Toaster } from "sonner";
import { CurrencyProvider } from "@/components/currency-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { UtcClock } from "@/components/utc-clock";

const ROUTE_TO_CRUMB: Record<string, string> = {
  "/": "Dashboard",
  "/bills": "Bills",
  "/accounts": "Accounts",
  "/transactions": "Transactions",
  "/credit-cards": "Credit cards",
  "/paychecks": "Paychecks",
  "/extras": "One-time",
  "/calendar": "Calendar",
  "/ledger": "Ledger",
  "/assets": "Assets",
  "/settings": "Settings",
};

export type { SidebarSummary };

export function AppShell({
  currency,
  displayName,
  role = "OWNER",
  sidebarSummary,
  children,
}: {
  currency: string;
  displayName: string;
  role?: string;
  sidebarSummary?: SidebarSummary | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "/";
  const crumb =
    ROUTE_TO_CRUMB[pathname] ??
    Object.entries(ROUTE_TO_CRUMB).find(
      ([route]) => route !== "/" && pathname.startsWith(`${route}/`),
    )?.[1] ??
    "ROOT";
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);

  return (
    <CurrencyProvider currency={currency}>
      <div
        data-app-shell
        className="flex h-screen w-screen overflow-hidden bg-[var(--bg-0)] text-[var(--text-0)]"
      >
        <Sidebar displayName={displayName} role={role} summary={sidebarSummary ?? null} />
        <MobileNav
          open={mobileNavOpen}
          onOpenChange={setMobileNavOpen}
          summary={sidebarSummary ?? null}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <header
            className="sticky top-0 z-10 flex h-[64px] shrink-0 items-center justify-between border-b border-[var(--border-raw)] px-4 backdrop-blur-md md:px-9"
            style={{ background: "var(--header-glass)" }}
          >
            <div className="flex items-center gap-3 text-[13px] font-medium text-[var(--text-2)]">
              <button
                type="button"
                onClick={() => setMobileNavOpen(true)}
                className="mr-1 rounded-full p-2 text-[var(--text-1)] transition-colors hover:bg-[var(--bg-2)] hover:text-[var(--text-0)] md:hidden"
                aria-label="Open navigation"
              >
                <Menu className="h-5 w-5" />
              </button>
              <span className="text-[var(--text-0)]">{crumb}</span>
              <span className="h-1 w-1 rounded-full bg-[var(--border-2)]" />
              <UtcClock />
            </div>
            <div className="flex items-center gap-3">
              <div className="hidden text-right text-[12px] text-[var(--text-2)] sm:block">
                <span className="block font-semibold text-[var(--text-0)]">{displayName}</span>
                <span>{role}</span>
              </div>
              <ThemeToggle />
            </div>
          </header>
          <main className="min-h-0 flex-1 overflow-auto px-4 pt-7 pb-28 md:px-9 md:pb-16">{children}</main>
        </div>
        <MobileTabBar />
      </div>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: "var(--bg-1)",
            color: "var(--text-0)",
            border: "1px solid var(--border-2)",
            borderRadius: "14px",
            boxShadow: "var(--shadow-md)",
            fontFamily: "var(--font-ui)",
            fontSize: "13px",
          },
        }}
      />
    </CurrencyProvider>
  );
}
