/**
 * Theme registry — single source of truth for every CSS-variable-driven
 * theme available to the app.
 *
 * The CSS blocks themselves live in `app/globals.css` under
 * `:root` (dark default) and `[data-theme="<id>"]` selectors. This module
 * mirrors them so the theme picker UI can render labels + previews without
 * parsing CSS, and so unit tests can assert that every registered theme
 * defines every required token.
 *
 * To add a new theme:
 *   1. Append an entry below with all tokens defined.
 *   2. Add a matching `[data-theme="<id>"]` block in `app/globals.css`.
 *   3. The picker auto-renders the new option.
 *
 * Keep tokens in this file in sync with `globals.css`. A vitest in
 * `themes.test.ts` enforces shape exhaustiveness.
 */

export type ThemeMode = "dark" | "light";

/**
 * Every CSS variable this app reads. Adding a new variable requires
 * updating every theme entry below — TypeScript's `Record<TokenName, ...>`
 * shape forces that exhaustiveness.
 */
export type TokenName =
  // Backgrounds
  | "bg-0"
  | "bg-1"
  | "bg-2"
  | "bg-3"
  | "bg-card"
  | "bg-inset"
  // Primary (cyan / accent)
  | "cyan"
  | "cyan-bright"
  | "cyan-dim"
  | "cyan-glow"
  // Phosphor accent
  | "phosphor"
  | "phosphor-dim"
  | "phosphor-glow"
  // Olive (structural / secondary)
  | "olive"
  | "olive-dark"
  // Status
  | "amber"
  | "red"
  | "red-glow"
  | "success"
  | "info"
  // Text hierarchy
  | "text-0"
  | "text-1"
  | "text-2"
  | "text-3"
  // Borders
  | "border-raw"
  | "border-2"
  | "border-dim";

export type ThemeTokens = Record<TokenName, string>;

export type Theme = {
  id: string;
  label: string;
  mode: ThemeMode;
  /** Short blurb shown in the picker. */
  description: string;
  tokens: ThemeTokens;
};

const DARK_TOKENS: ThemeTokens = {
  "bg-0": "#080B0E",
  "bg-1": "#0E1318",
  "bg-2": "#141A22",
  "bg-3": "#1A2232",
  "bg-card": "#0E1318",
  "bg-inset": "#060A0D",

  cyan: "#00E5FF",
  "cyan-bright": "#22F3FF",
  "cyan-dim": "#0099BB",
  "cyan-glow": "rgba(0, 229, 255, 0.35)",

  phosphor: "#39FF14",
  "phosphor-dim": "#22CC00",
  "phosphor-glow": "rgba(57, 255, 20, 0.30)",

  olive: "#6B7C4A",
  "olive-dark": "#3D4A2B",

  amber: "#FF8C00",
  red: "#FF1744",
  "red-glow": "rgba(255, 23, 68, 0.20)",
  success: "#00E676",
  info: "#448AFF",

  "text-0": "#E8EDF2",
  "text-1": "#B8C5D2",
  "text-2": "#8A9BB0",
  "text-3": "#4A5C6E",

  "border-raw": "#1F2B38",
  "border-2": "#2A3E54",
  "border-dim": "#131C26",
};

const LIGHT_TOKENS: ThemeTokens = {
  "bg-0": "#EEF1F5",
  "bg-1": "#E4E8EE",
  "bg-2": "#F6F8FA",
  "bg-3": "#FFFFFF",
  "bg-card": "#E4E8EE",
  "bg-inset": "#D8DCE4",

  cyan: "#007A99",
  "cyan-bright": "#009FC4",
  "cyan-dim": "#005C75",
  "cyan-glow": "rgba(0, 122, 153, 0.20)",

  phosphor: "#2A8C00",
  "phosphor-dim": "#1C6000",
  "phosphor-glow": "rgba(42, 140, 0, 0.18)",

  olive: "#5A6B3A",
  "olive-dark": "#3A4A22",

  amber: "#B85C00",
  red: "#C0002E",
  "red-glow": "rgba(192, 0, 46, 0.20)",
  success: "#007A3D",
  info: "#1A5FCC",

  "text-0": "#111820",
  "text-1": "#3A4E62",
  "text-2": "#5A6E82",
  "text-3": "#7A8FA0",

  "border-raw": "#B8C4D0",
  "border-2": "#8A9BB0",
  "border-dim": "#D0D8E2",
};

/**
 * Phosphor — single-accent monochrome amber CRT. For users who find the
 * cyan/phosphor pair too intense. Background stays tactical-black; every
 * accent collapses to amber.
 */
const PHOSPHOR_TOKENS: ThemeTokens = {
  "bg-0": "#0A0700",
  "bg-1": "#120D02",
  "bg-2": "#1A1306",
  "bg-3": "#221A0A",
  "bg-card": "#120D02",
  "bg-inset": "#070500",

  cyan: "#FFB000",
  "cyan-bright": "#FFC940",
  "cyan-dim": "#A06D00",
  "cyan-glow": "rgba(255, 176, 0, 0.30)",

  phosphor: "#FFB000",
  "phosphor-dim": "#A06D00",
  "phosphor-glow": "rgba(255, 176, 0, 0.22)",

  olive: "#6B5A2A",
  "olive-dark": "#3D331A",

  amber: "#FF8C00",
  red: "#FF4400",
  "red-glow": "rgba(255, 68, 0, 0.20)",
  success: "#FFB000",
  info: "#FFB000",

  "text-0": "#FFE3A6",
  "text-1": "#D4B97A",
  "text-2": "#9C8754",
  "text-3": "#5C5030",

  "border-raw": "#3D331A",
  "border-2": "#5C4D26",
  "border-dim": "#221A0A",
};

/**
 * Daylight — warmer light theme. Cream paper instead of cool grey, slightly
 * higher saturation accents so it reads well in actual sunlight. Same token
 * shape as the cool light theme — flips by data-attribute.
 */
const DAYLIGHT_TOKENS: ThemeTokens = {
  "bg-0": "#F8F2E5",
  "bg-1": "#F1E8D2",
  "bg-2": "#FCF7EA",
  "bg-3": "#FFFCF2",
  "bg-card": "#F1E8D2",
  "bg-inset": "#E8DCBE",

  cyan: "#0F6E8A",
  "cyan-bright": "#1290B4",
  "cyan-dim": "#0A526A",
  "cyan-glow": "rgba(15, 110, 138, 0.22)",

  phosphor: "#3D7A12",
  "phosphor-dim": "#2A5408",
  "phosphor-glow": "rgba(61, 122, 18, 0.20)",

  olive: "#665830",
  "olive-dark": "#403619",

  amber: "#A0480A",
  red: "#A8002A",
  "red-glow": "rgba(168, 0, 42, 0.20)",
  success: "#1F6A2C",
  info: "#1A5FCC",

  "text-0": "#1F1A10",
  "text-1": "#48402E",
  "text-2": "#6E6448",
  "text-3": "#9C8E70",

  "border-raw": "#C2B393",
  "border-2": "#9C8E70",
  "border-dim": "#D9CCA9",
};

/**
 * High-contrast — pure black/white with structural accents only. Targets
 * WCAG AAA. Useful for users with low vision or working in bright
 * sunlight on a glossy display.
 */
const HIGH_CONTRAST_TOKENS: ThemeTokens = {
  "bg-0": "#000000",
  "bg-1": "#0A0A0A",
  "bg-2": "#141414",
  "bg-3": "#1F1F1F",
  "bg-card": "#0A0A0A",
  "bg-inset": "#000000",

  cyan: "#FFFFFF",
  "cyan-bright": "#FFFFFF",
  "cyan-dim": "#CCCCCC",
  "cyan-glow": "rgba(255, 255, 255, 0.40)",

  phosphor: "#FFFF00",
  "phosphor-dim": "#CCCC00",
  "phosphor-glow": "rgba(255, 255, 0, 0.30)",

  olive: "#888888",
  "olive-dark": "#555555",

  amber: "#FFAA00",
  red: "#FF4040",
  "red-glow": "rgba(255, 64, 64, 0.30)",
  success: "#00FF80",
  info: "#80B0FF",

  "text-0": "#FFFFFF",
  "text-1": "#E8E8E8",
  "text-2": "#B8B8B8",
  "text-3": "#888888",

  "border-raw": "#444444",
  "border-2": "#888888",
  "border-dim": "#222222",
};

export const THEMES: Theme[] = [
  {
    id: "dark",
    label: "Tactical Dark",
    mode: "dark",
    description: "Cyberpunk × military: cyan + phosphor on tactical black",
    tokens: DARK_TOKENS,
  },
  {
    id: "light",
    label: "Field Manual",
    mode: "light",
    description: "Cool field-manual paper, navy-teal + forest accents",
    tokens: LIGHT_TOKENS,
  },
  {
    id: "phosphor",
    label: "Phosphor CRT",
    mode: "dark",
    description: "Single-accent amber monochrome — terminal nostalgia",
    tokens: PHOSPHOR_TOKENS,
  },
  {
    id: "daylight",
    label: "Daylight",
    mode: "light",
    description: "Warm cream paper for outdoor / glossy-screen reading",
    tokens: DAYLIGHT_TOKENS,
  },
  {
    id: "high-contrast",
    label: "High Contrast",
    mode: "dark",
    description: "Pure black/white, WCAG-AAA targeting",
    tokens: HIGH_CONTRAST_TOKENS,
  },
];

export const THEME_IDS = THEMES.map((t) => t.id);

export function getTheme(id: string): Theme | undefined {
  return THEMES.find((t) => t.id === id);
}

/**
 * Default theme id when the user hasn't picked one. Matches `next-themes`
 * defaultTheme so SSR and hydration agree.
 */
export const DEFAULT_THEME_ID = "dark";
