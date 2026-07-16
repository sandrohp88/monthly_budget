"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

/** Single navigation row — shared by the desktop Sidebar and the mobile
 *  drawer so both stay visually identical (active treatment, spacing, icon). */
export function NavItem({
  href,
  icon: Icon,
  label,
  active,
  shortcut,
  onNavigate,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: React.ReactNode;
  active: boolean;
  shortcut?: string;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "mx-3 flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-[13px] font-medium",
        "border border-transparent transition-all",
        active
          ? "border-[var(--border-raw)] bg-[var(--bg-card)] text-[var(--mint)] shadow-[var(--shadow-sm)]"
          : "text-[var(--text-1)] hover:bg-[var(--bg-2)] hover:text-[var(--text-0)]",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1">{label}</span>
      {shortcut ? (
        <kbd className="text-[11px] tracking-normal text-[var(--text-3)]">g {shortcut}</kbd>
      ) : null}
    </Link>
  );
}
