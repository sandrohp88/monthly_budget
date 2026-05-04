"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ChartLine,
  CircleDollarSign,
  CreditCard,
  LayoutDashboard,
  Landmark,
  PartyPopper,
  ReceiptText,
  Settings,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/cn";

const NAV: ReadonlyArray<{
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
  { href: "/projection", label: "Projection", icon: ChartLine, shortcut: "x", section: 1 },
  { href: "/settings", label: "Settings", icon: Settings, shortcut: "s", section: 2 },
];

export function Sidebar({ displayName, role }: { displayName: string; role: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [armed, setArmed] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
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
          "flex items-center gap-2.5 px-5 py-2.5 text-[11px] uppercase tracking-[0.1em] cursor-pointer",
          "border-l-2 border-transparent transition-all",
          active
            ? "bg-gradient-to-r from-[var(--mint-glow)] to-transparent text-[var(--mint)] border-l-[var(--mint)]"
            : "text-[var(--text-1)] hover:bg-[var(--bg-2)] hover:text-[var(--text-0)]",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
        <span className="flex-1">{item.label}</span>
        <kbd className="text-[9px] text-[var(--text-3)] tracking-normal">g {item.shortcut}</kbd>
      </Link>
    );
  };

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-[var(--border-raw)] bg-[var(--bg-1)] md:flex relative">
      {/* mint glow on the right edge */}
      <div
        aria-hidden
        className="absolute right-[-1px] top-0 bottom-0 w-px opacity-50"
        style={{
          background:
            "linear-gradient(180deg, transparent, var(--mint-dim) 30%, var(--mint-dim) 70%, transparent)",
        }}
      />

      {/* brand */}
      <div className="flex items-center gap-2.5 border-b border-[var(--border-raw)] px-5 py-[14px]">
        <div
          className="grid h-7 w-7 place-items-center rounded-sm bg-[var(--mint)] text-[14px] font-extrabold text-[var(--bg-0)] tracking-tight"
          style={{ boxShadow: "0 0 14px var(--mint-glow)" }}
        >
          $
        </div>
        <div>
          <div className="text-[12px] font-bold uppercase tracking-[0.1em]">FINANCE_OS</div>
          <div className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-3)] mt-0.5">
            v1.0.0 // local
          </div>
        </div>
      </div>

      {/* status block */}
      <div className="border-b border-[var(--border-raw)] px-5 py-3 text-[10px] tracking-wider text-[var(--text-2)] leading-[1.9]">
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
        <div className="mx-3 mb-2 rounded-sm border border-[var(--mint-dim)] bg-[var(--bg-2)] px-3 py-1.5 text-[9px] uppercase tracking-[0.15em] text-[var(--mint)]">
      press: d b a t c p e x s
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
          <div className="text-[9px] uppercase tracking-[0.12em] text-[var(--text-2)]">{role}</div>
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

function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "px-5 pt-2 pb-1.5 text-[9px] uppercase tracking-[0.2em] text-[var(--text-3)]",
        className,
      )}
    >
      {`// ${children}`}
    </div>
  );
}
