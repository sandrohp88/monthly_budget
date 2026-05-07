"use client";

import * as React from "react";
import { ThemeProvider as NextThemes } from "next-themes";
import { DEFAULT_THEME_ID, THEME_IDS } from "@/lib/themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemes
      attribute={["class", "data-theme"]}
      defaultTheme={DEFAULT_THEME_ID}
      themes={[...THEME_IDS]}
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemes>
  );
}
