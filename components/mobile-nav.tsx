"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { NAV, type SidebarSummary } from "@/components/sidebar";
import { NavItem } from "@/components/ui/nav-item";
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
      <SheetContent side="left" className="w-72 max-w-72 p-0">
        <SheetTitle className="sr-only">Navigation</SheetTitle>

        {/* brand */}
        <div className="flex items-center gap-3 border-b border-[var(--border-raw)] px-5 py-4">
          <span
            className="block h-9 w-9 rounded-md bg-cover bg-center"
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
          <SectionLabel>Core</SectionLabel>
          {NAV.filter((n) => n.section === 1).map((item) => (
            <NavItem
              key={item.href}
              href={item.href}
              icon={item.icon}
              label={item.label}
              active={pathname === item.href}
            />
          ))}
          <SectionLabel className="mt-4">More</SectionLabel>
          {NAV.filter((n) => n.section === 2).map((item) => (
            <NavItem
              key={item.href}
              href={item.href}
              icon={item.icon}
              label={item.label}
              active={pathname === item.href}
            />
          ))}
        </nav>

        {/* net position widget */}
        {summary && summary.sparkline.length >= 2 ? (
          <div className="border-t border-[var(--border-raw)] px-5 py-3">
            <div className="mb-1.5 text-[12px] font-medium text-[var(--text-3)]">
              Net position
            </div>
            <div className="tabular text-[15px] font-bold leading-none text-[var(--text-0)]">
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
        "px-6 pt-2 pb-1.5 text-[12px] font-semibold text-[var(--text-3)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
