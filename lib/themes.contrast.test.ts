import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { THEME_IDS } from "./themes";

// Review 2026-09-21 R10, measured in the browser and locked in here. Parses
// app/globals.css, resolves each theme's tokens exactly as the cascade does
// (a theme block inherits every token it doesn't set from the :root light
// block — which is how "phosphor" once picked up paper-tuned accents), and
// requires WCAG AA for every token the UI uses as text.

const css = fs.readFileSync(path.resolve("app/globals.css"), "utf8");

function tokensOf(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no block for ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n  }", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!;
  return out;
}

const root = tokensOf('[data-theme="light"] {');
const resolved = (id: string) => (id === "light" ? root : { ...root, ...tokensOf(`[data-theme="${id}"] {`) });

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};
/** fg at `alpha` over bg — the tinted chips are `color-mix(token 14%)`. */
const tint = (fg: string, alpha: number, bg: string) =>
  "#" + [1, 3, 5].map((i) => Math.round(parseInt(fg.slice(i, i + 2), 16) * alpha + parseInt(bg.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, "0")).join("");

const SURFACES = ["bg-0", "bg-1", "bg-2", "bg-3"];
const TEXT_TOKENS = ["text-0", "text-1", "text-2", "text-3", "mint", "amber", "red", "success", "info", "olive"];

describe("theme contrast (WCAG AA 4.5:1 for text)", () => {
  for (const id of THEME_IDS) {
    const t = resolved(id);
    for (const token of TEXT_TOKENS) {
      it(`${id}: --${token} on every surface and on its own tinted chip`, () => {
        for (const bg of SURFACES) {
          expect(ratio(t[token]!, t[bg]!), `${id} --${token} on --${bg}`).toBeGreaterThanOrEqual(4.5);
        }
        expect(ratio(t[token]!, tint(t[token]!, 0.14, t["bg-1"]!)), `${id} --${token} chip`).toBeGreaterThanOrEqual(4.5);
      });
    }
    it(`${id}: filled-button and alert-tag text is readable`, () => {
      if (t["button-primary-fg"]) {
        expect(ratio(t["button-primary-fg"], t.mint!), `${id} primary button`).toBeGreaterThanOrEqual(4.5);
      }
      for (const fill of ["amber", "mint", "red"]) {
        expect(ratio(t["bg-0"]!, t[fill]!), `${id} AlertBar ${fill} tag`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe("accessible names (R11)", () => {
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".tsx") ? [path.join(dir, e.name)] : [],
    );
  it("every MoneyInput has an id (for its <Label htmlFor>) or an aria-label", () => {
    const unnamed: string[] = [];
    for (const f of [...files("app"), ...files("components")]) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/<MoneyInput\b([\s\S]*?)\/>/g)) {
        if (!/\b(id|aria-label|aria-labelledby)=/.test(m[1]!)) unnamed.push(`${f}:${src.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(unnamed).toEqual([]);
  });
});
