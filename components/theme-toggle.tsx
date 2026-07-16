"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Palette } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@radix-ui/react-dropdown-menu";
import { Button } from "@/components/ui/button";
import { THEMES, DEFAULT_THEME_ID } from "@/lib/themes";
import { cn } from "@/lib/cn";

/**
 * Theme picker. Replaces the previous binary dark/light toggle with a
 * dropdown listing every theme registered in `lib/themes.ts`. The active
 * theme is highlighted.
 *
 * Mounted in the top bar (see `components/app-shell.tsx`). The picker is
 * a no-op until next-themes hydrates — guarded by a `mounted` boolean
 * so SSR + first-paint don't race the localStorage read.
 */
export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const active = mounted
    ? theme === "system"
      ? (resolvedTheme ?? DEFAULT_THEME_ID)
      : (theme ?? DEFAULT_THEME_ID)
    : DEFAULT_THEME_ID;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Choose theme"
          title="Choose theme"
        >
          <Palette className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="z-50 min-w-[15rem] rounded-lg border border-[var(--border-raw)] bg-[var(--bg-card)] p-1.5 shadow-[var(--shadow-md)]"
      >
        <DropdownMenuLabel className="px-3 py-2 text-[12px] font-semibold text-[var(--text-3)]">
          Theme
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="my-1 h-px bg-[var(--border-raw)]" />
        {THEMES.map((t) => (
          <DropdownMenuItem
            key={t.id}
            onSelect={() => setTheme(t.id)}
            className={cn(
              "flex cursor-pointer flex-col gap-0.5 rounded-md px-3 py-2 text-[12px] outline-none",
              "focus:bg-[var(--bg-2)]",
              active === t.id && "bg-[var(--mint-glow)] text-[var(--mint)]",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-semibold text-[var(--text-0)]">
                {t.label}
              </span>
              <span className="text-[11px] text-[var(--text-3)]">
                {t.mode}
              </span>
            </div>
            <span className="text-[11px] leading-relaxed text-[var(--text-2)]">{t.description}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator className="my-1 h-px bg-[var(--border-raw)]" />
        <DropdownMenuItem
          onSelect={() => setTheme("system")}
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-[12px] outline-none",
            "focus:bg-[var(--bg-2)]",
            theme === "system" && "bg-[var(--mint-glow)] text-[var(--mint)]",
          )}
        >
          <span className="text-[var(--text-1)]">Follow system</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
