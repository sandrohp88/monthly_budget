"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  CalendarDays,
  ChartLine,
  CircleDollarSign,
  CreditCard,
  Gem,
  LayoutDashboard,
  Landmark,
  PartyPopper,
  ReceiptText,
  Settings,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Sparkline } from "@/components/ui/sparkline";
import { Money } from "@/components/money";

export type SidebarSummary = {
  startingBalanceCents: number;
  sparkline: number[];
  deltaCents: number;
};

export const NAV: ReadonlyArray<{
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  shortcut: string;
  section: 1 | 2;
}> = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, shortcut: "d", section: 1 },
  { href: "/bills", label: "Bills", icon: CreditCard, shortcut: "b", section: 1 },
  { href: "/accounts", label: "Accounts", icon: Landmark, shortcut: "a", section: 1 },
  { href: "/transactions", label: "Transactions", icon: ReceiptText, shortcut: "t", section: 1 },
  { href: "/credit-cards", label: "Credit Cards", icon: Wallet, shortcut: "c", section: 1 },
  { href: "/paychecks", label: "Paychecks", icon: CircleDollarSign, shortcut: "p", section: 1 },
  { href: "/extras", label: "One-Time", icon: PartyPopper, shortcut: "e", section: 1 },
  { href: "/calendar", label: "Calendar", icon: CalendarDays, shortcut: "l", section: 1 },
  { href: "/ledger", label: "Ledger", icon: ChartLine, shortcut: "x", section: 1 },
  { href: "/assets", label: "Assets", icon: Gem, shortcut: "w", section: 1 },
  { href: "/settings", label: "Settings", icon: Settings, shortcut: "s", section: 2 },
];

export function Sidebar({
  displayName,
  role,
  summary,
}: {
  displayName: string;
  role: string;
  summary: SidebarSummary | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [armed, setArmed] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "g" && !armed) {
        setArmed(true);
        setTimeout(() => setArmed(false), 1500);
        return;
      }
      if (armed) {
        const item = NAV.find((n) => n.shortcut === e.key);
        if (item) {
          e.preventDefault();
          router.push(item.href);
        }
        setArmed(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed, router]);

  const initials = (displayName || "U")
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const renderItem = (item: (typeof NAV)[number]) => {
    const Icon = item.icon;
    const active = pathname === item.href;
    return (
      <Link
        key={item.href}
        href={item.href}
        className={cn(
          "mx-3 flex cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2.5 text-[13px] font-medium",
          "border border-transparent transition-all",
          active
            ? "border-[var(--border-raw)] bg-[var(--bg-card)] text-[var(--mint)] shadow-[var(--shadow-sm)]"
            : "text-[var(--text-1)] hover:bg-[var(--bg-2)] hover:text-[var(--text-0)]",
        )}
      >
        <Icon className="h-4 w-4" />
        <span className="flex-1">{item.label}</span>
        <kbd className="text-[11px] tracking-normal text-[var(--text-3)]">g {item.shortcut}</kbd>
      </Link>
    );
  };

  return (
    <aside className="relative hidden w-60 shrink-0 flex-col border-r border-[var(--border-raw)] bg-[var(--bg-0)] md:flex">
      <div className="flex items-center gap-3 border-b border-[var(--border-raw)] px-5 py-4">
        <span
          className="block h-9 w-9 rounded-[8px] bg-cover bg-center"
          style={{
            backgroundImage: "url('/icons/bluefalls-mark.svg')",
            boxShadow: "0 10px 24px rgba(80, 214, 201, 0.2)",
          }}
          aria-hidden="true"
        />
        <div>
          <div className="text-[18px] font-extrabold tracking-normal">Monthly Budget</div>
          <div className="mt-0.5 text-[12px] text-[var(--text-3)]">Bluefalls finance</div>
        </div>
      </div>

      {/* nav */}
      <nav className="flex-1 overflow-y-auto py-3">
        <SectionLabel>Plan</SectionLabel>
        {NAV.filter((n) => n.section === 1).map(renderItem)}
        <SectionLabel className="mt-4">Manage</SectionLabel>
        {NAV.filter((n) => n.section === 2).map(renderItem)}
      </nav>

      {armed ? (
        <div className="mx-3 mb-2 rounded-full border border-[var(--mint-dim)] bg-[var(--mint-glow)] px-3 py-1.5 text-[12px] text-[var(--mint)]">
          press: {NAV.map((n) => n.shortcut).join(" ")}
        </div>
      ) : null}

      {/* net position widget */}
      {summary && summary.sparkline.length >= 2 ? (
        <div className="border-t border-[var(--border-raw)] px-5 py-3">
          <div className="mb-1.5 text-[12px] font-medium text-[var(--text-3)]">
            Net position
          </div>
          <div className="tabular text-[15px] leading-none font-bold text-[var(--text-0)]">
            <Money cents={summary.startingBalanceCents} />
          </div>
          <div className="mt-2">
            <Sparkline data={summary.sparkline} height={26} stroke="var(--mint)" />
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px]">
            <span className="text-[var(--text-3)]">30D</span>
            <span
              className={cn(
                "tabular",
                summary.deltaCents > 0
                  ? "text-[var(--mint)]"
                  : summary.deltaCents < 0
                    ? "text-[var(--red)]"
                    : "text-[var(--text-2)]",
              )}
            >
              {summary.deltaCents > 0 ? "+" : summary.deltaCents < 0 ? "−" : ""}
              <Money cents={Math.abs(summary.deltaCents)} />
            </span>
          </div>
        </div>
      ) : null}

      {/* user card */}
      <div className="flex items-center gap-2.5 border-t border-[var(--border-raw)] px-4 py-3">
        <div className="grid h-8 w-8 place-items-center rounded-full border border-[var(--border-raw)] bg-[var(--bg-card)] text-[11px] font-bold text-[var(--mint)]">
          {initials}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold text-[var(--text-0)]">
            {displayName}
          </div>
          <div className="text-[11px] text-[var(--text-2)]">{role}</div>
        </div>
      </div>
    </aside>
  );
}

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "px-6 pt-2 pb-1.5 text-[12px] font-semibold text-[var(--text-3)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
