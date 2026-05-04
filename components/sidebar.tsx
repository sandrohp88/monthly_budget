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
          "flex cursor-pointer items-center gap-3 px-4 py-2.5 text-[12px] font-semibold uppercase tracking-[0.06em]",
          "border-l-2 border-transparent transition-colors",
          active
            ? "border-l-[var(--mint)] bg-[var(--mint-glow)] text-[var(--mint)]"
            : "text-[var(--text-1)] hover:bg-[var(--bg-2)] hover:text-[var(--text-0)]",
        )}
      >
        <Icon className="h-4 w-4" />
        <span className="flex-1">{item.label}</span>
        <kbd className="text-[9px] text-[var(--text-3)] tracking-normal">g {item.shortcut}</kbd>
      </Link>
    );
  };

  return (
    <aside className="relative hidden w-60 shrink-0 flex-col border-r border-[var(--border-raw)] bg-[var(--sidebar-bg)] backdrop-blur-xl md:flex">
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
      <div className="flex items-center gap-2.5 border-b border-[var(--border-raw)] px-5 py-4">
        <div
          className="grid h-8 w-8 place-items-center rounded-sm bg-[var(--mint)] text-[14px] font-extrabold text-white tracking-tight dark:text-[var(--bg-0)]"
        >
          $
        </div>
        <div>
          <div className="text-[13px] font-bold uppercase tracking-[0.08em]">FINANCE_OS</div>
          <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-[var(--text-3)]">
            Local budget console
          </div>
        </div>
      </div>

      <div className="border-b border-[var(--border-raw)] px-5 py-3">
        <div className="flex items-center justify-between rounded-sm border border-[var(--border-dim)] bg-[var(--bg-card)] px-3 py-2">
          <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-2)]">System</span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--mint)]">
            Online
          </span>
        </div>
      </div>

      {/* nav */}
      <nav className="flex-1 overflow-y-auto py-3">
        <SectionLabel>Primary</SectionLabel>
        {NAV.filter((n) => n.section === 1).map(renderItem)}
        <SectionLabel className="mt-4">System</SectionLabel>
        {NAV.filter((n) => n.section === 2).map(renderItem)}
      </nav>

      {armed ? (
        <div className="mx-3 mb-2 rounded-sm border border-[var(--mint-dim)] bg-[var(--bg-2)] px-3 py-1.5 text-[9px] uppercase tracking-[0.12em] text-[var(--mint)]">
          press: d b a c p e x s
        </div>
      ) : null}

      {/* user card */}
      <div className="flex items-center gap-2.5 border-t border-[var(--border-raw)] px-4 py-3">
        <div className="grid h-8 w-8 place-items-center rounded-sm border border-[var(--mint-dim)] bg-[var(--bg-3)] text-[10px] font-bold text-[var(--mint)]">
          {initials}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold text-[var(--text-0)]">
            {displayName.toUpperCase()}
          </div>
          <div className="text-[9px] uppercase tracking-[0.12em] text-[var(--text-2)]">{role}</div>
        </div>
      </div>
    </aside>
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
        "px-5 pb-1.5 pt-2 text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
