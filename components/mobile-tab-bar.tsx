"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { NAV } from "@/components/sidebar";

// Compact labels — five columns on a phone leave no room for "Transactions".
const SHORT_LABELS: Record<string, string> = {
  "/": "Home",
  "/calendar": "Calendar",
  "/bills": "Bills",
  "/transactions": "Activity",
  "/accounts": "Accounts",
};

/**
 * Bottom tab bar for the Core nav section, phones only (`md:hidden`) — the
 * daily-glance pages shouldn't cost a hamburger round-trip. Everything else
 * stays reachable through the existing sheet nav.
 */
export function MobileTabBar() {
  const pathname = usePathname();
  const items = NAV.filter((n) => n.section === 1);

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-20 flex border-t border-[var(--border-raw)] bg-[var(--bg-0)]/95 backdrop-blur-md md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {items.map((item) => {
        const Icon = item.icon;
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center gap-1 py-2 text-[9px] font-semibold uppercase tracking-[0.08em] transition-colors",
              active ? "text-[var(--mint)]" : "text-[var(--text-2)] hover:text-[var(--text-0)]",
            )}
          >
            <Icon className="h-4 w-4" />
            {SHORT_LABELS[item.href] ?? item.label}
          </Link>
        );
      })}
    </nav>
  );
}
