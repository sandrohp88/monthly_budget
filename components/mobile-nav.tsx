"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { NAV, type SidebarSummary } from "@/components/sidebar";
import { Sparkline } from "@/components/ui/sparkline";
import { Money } from "@/components/money";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";

export function MobileNav({
  open,
  onOpenChange,
  summary,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: SidebarSummary | null;
}) {
  const pathname = usePathname();
  const prevPathRef = React.useRef(pathname);

  React.useEffect(() => {
    if (pathname !== prevPathRef.current) {
      prevPathRef.current = pathname;
      onOpenChange(false);
    }
  }, [pathname, onOpenChange]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-60 max-w-60 p-0">
        <SheetTitle className="sr-only">Navigation</SheetTitle>

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

        {/* nav */}
        <nav className="flex-1 overflow-y-auto py-3">
          <SectionLabel>NAV_01</SectionLabel>
          {NAV.filter((n) => n.section === 1).map((item) => {
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
              </Link>
            );
          })}
          <SectionLabel className="mt-4">NAV_02</SectionLabel>
          {NAV.filter((n) => n.section === 2).map((item) => {
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
              </Link>
            );
          })}
        </nav>

        {/* net position widget */}
        {summary && summary.sparkline.length >= 2 ? (
          <div className="border-t border-[var(--border-raw)] px-5 py-3">
            <div className="mb-1.5 text-[9px] uppercase tracking-[0.2em] text-[var(--text-3)]">
              {"// NET POSITION"}
            </div>
            <div className="tabular text-[15px] font-bold leading-none text-[var(--text-0)]">
              <Money cents={summary.startingBalanceCents} />
            </div>
            <div className="mt-2">
              <Sparkline data={summary.sparkline} height={26} stroke="var(--mint)" />
            </div>
            <div className="mt-1 flex items-center justify-between text-[9px] uppercase tracking-[0.15em]">
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
      </SheetContent>
    </Sheet>
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
