"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
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
  { href: "/projection", label: "Ledger", icon: ChartLine, shortcut: "x", section: 1 },
  { href: "/assets", label: "Assets", icon: Gem, shortcut: "w", section: 1 },
  { href: "/reports", label: "Reports", icon: BarChart3, shortcut: "r", section: 1 },
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
          "flex cursor-pointer items-center gap-2.5 px-5 py-2.5 text-[11px] tracking-[0.1em] uppercase",
          "border-l-2 border-transparent transition-all",
          active
            ? "border-l-[var(--mint)] bg-gradient-to-r from-[var(--mint-glow)] to-transparent text-[var(--mint)]"
            : "text-[var(--text-1)] hover:bg-[var(--bg-2)] hover:text-[var(--text-0)]",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
        <span className="flex-1">{item.label}</span>
        <kbd className="text-[9px] tracking-normal text-[var(--text-3)]">g {item.shortcut}</kbd>
      </Link>
    );
  };

  return (
    <aside className="relative hidden w-60 shrink-0 flex-col border-r border-[var(--border-raw)] bg-[var(--bg-1)] md:flex">
      {/* mint glow on the right edge */}
      <div
        aria-hidden
        className="absolute top-0 right-[-1px] bottom-0 w-px opacity-50"
        style={{
          background:
            "linear-gradient(180deg, transparent, var(--mint-dim) 30%, var(--mint-dim) 70%, transparent)",
        }}
      />

      {/* brand */}
      <div className="flex items-center gap-2.5 border-b border-[var(--border-raw)] px-5 py-[14px]">
        <div
          className="grid h-7 w-7 place-items-center rounded-sm bg-[var(--mint)] text-[14px] font-extrabold tracking-tight text-[var(--bg-0)]"
          style={{ boxShadow: "0 0 14px var(--mint-glow)" }}
        >
          $
        </div>
        <div>
          <div className="text-[12px] font-bold tracking-[0.1em] uppercase">FINANCE_OS</div>
          <div className="mt-0.5 text-[9px] tracking-[0.1em] text-[var(--text-3)] uppercase">
            v1.0.0 // local
          </div>
        </div>
      </div>

      {/* status block */}
      <div className="border-b border-[var(--border-raw)] px-5 py-3 text-[10px] leading-[1.9] tracking-wider text-[var(--text-2)]">
        <Row k="// SYSTEM" v="ONLINE" />
        <Row k="// SYNC" v="OK" />
        <Row k="// MODE" v="LOCAL" />
        <Row k="// BUILD" v="1.0.0" />
      </div>

      {/* nav */}
      <nav className="flex-1 overflow-y-auto py-3">
        <SectionLabel>NAV_01</SectionLabel>
        {NAV.filter((n) => n.section === 1).map(renderItem)}
        <SectionLabel className="mt-4">NAV_02</SectionLabel>
        {NAV.filter((n) => n.section === 2).map(renderItem)}
      </nav>

      {armed ? (
        <div className="mx-3 mb-2 rounded-sm border border-[var(--mint-dim)] bg-[var(--bg-2)] px-3 py-1.5 text-[9px] tracking-[0.15em] text-[var(--mint)] uppercase">
          press: d b a t c p e x w r s
        </div>
      ) : null}

      {/* net position widget */}
      {summary && summary.sparkline.length >= 2 ? (
        <div className="border-t border-[var(--border-raw)] px-5 py-3">
          <div className="mb-1.5 text-[9px] tracking-[0.2em] text-[var(--text-3)] uppercase">
            {"// NET POSITION"}
          </div>
          <div className="tabular text-[15px] leading-none font-bold text-[var(--text-0)]">
            <Money cents={summary.startingBalanceCents} />
          </div>
          <div className="mt-2">
            <Sparkline data={summary.sparkline} height={26} stroke="var(--mint)" />
          </div>
          <div className="mt-1 flex items-center justify-between text-[9px] tracking-[0.15em] uppercase">
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
        <div className="grid h-7 w-7 place-items-center rounded-sm border border-[var(--mint-dim)] bg-[var(--bg-3)] text-[10px] font-bold text-[var(--mint)]">
          {initials}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold text-[var(--text-0)]">
            {displayName.toUpperCase()}
          </div>
          <div className="text-[9px] tracking-[0.12em] text-[var(--text-2)] uppercase">{role}</div>
        </div>
      </div>
    </aside>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span>{k}</span>
      <span className="text-[var(--mint)]">{v}</span>
    </div>
  );
}

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "px-5 pt-2 pb-1.5 text-[9px] tracking-[0.2em] text-[var(--text-3)] uppercase",
        className,
      )}
    >
      {`// ${children}`}
    </div>
  );
}
