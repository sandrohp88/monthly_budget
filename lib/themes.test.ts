import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_ID, THEMES, getTheme } from "./themes";

const REQUIRED_TOKENS = [
  "bg-0",
  "bg-1",
  "bg-2",
  "bg-3",
  "bg-card",
  "bg-inset",
  "cyan",
  "cyan-bright",
  "cyan-dim",
  "cyan-glow",
  "phosphor",
  "phosphor-dim",
  "phosphor-glow",
  "olive",
  "olive-dark",
  "amber",
  "red",
  "red-glow",
  "success",
  "info",
  "text-0",
  "text-1",
  "text-2",
  "text-3",
  "border-raw",
  "border-2",
  "border-dim",
] as const;

describe("themes registry", () => {
  it("includes the default theme id", () => {
    expect(getTheme(DEFAULT_THEME_ID)).toBeDefined();
  });

  it("has unique theme ids", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every theme defines every required token (non-empty string)", () => {
    for (const theme of THEMES) {
      for (const token of REQUIRED_TOKENS) {
        const value = theme.tokens[token];
        expect(
          value,
          `theme "${theme.id}" missing or empty token "${token}"`,
        ).toBeTruthy();
        expect(typeof value).toBe("string");
      }
    }
  });

  it("every theme has a label and description (used by the picker)", () => {
    for (const theme of THEMES) {
      expect(theme.label.length).toBeGreaterThan(0);
      expect(theme.description.length).toBeGreaterThan(0);
    }
  });

  it("modes are constrained to dark | light", () => {
    for (const theme of THEMES) {
      expect(["dark", "light"]).toContain(theme.mode);
    }
  });
});
