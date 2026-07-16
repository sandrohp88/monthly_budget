// Rasterize the Bluefalls mark into the PWA icon set. Rerun after changing
// public/icons/bluefalls-mark.svg:
//
//   node scripts/generate-icons.mjs
//
// Uses the Playwright chromium already installed for the e2e suite — no
// extra image dependencies. Outputs land in public/icons/ and are committed.
//
// Variants:
//   icon-192.png / icon-512.png          purpose "any" — the mark's own
//                                        rounded tile, transparent corners
//   icon-maskable-192.png / -512.png     purpose "maskable" — full-bleed
//                                        #101316 square, mark scaled to 80%
//                                        so launcher masks don't clip it
//   apple-touch-icon.png (180x180)       opaque full-bleed for iOS
//                                        Add to Home Screen

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "@playwright/test";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const iconsDir = path.join(root, "public", "icons");
const svg = await readFile(path.join(iconsDir, "bluefalls-mark.svg"), "utf8");
const svgUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

// scale = mark size relative to the canvas; background null = transparent
const TARGETS = [
  { file: "icon-192.png", size: 192, scale: 1, background: null },
  { file: "icon-512.png", size: 512, scale: 1, background: null },
  { file: "icon-maskable-192.png", size: 192, scale: 0.8, background: "#101316" },
  { file: "icon-maskable-512.png", size: 512, scale: 0.8, background: "#101316" },
  { file: "apple-touch-icon.png", size: 180, scale: 1, background: "#101316" },
];

const browser = await chromium.launch();
const page = await browser.newPage();

for (const { file, size, scale, background } of TARGETS) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;width:${size}px;height:${size}px;background:${background ?? "transparent"};display:grid;place-items:center">` +
      `<img src="${svgUrl}" style="width:${size * scale}px;height:${size * scale}px" />` +
      `</body>`,
  );
  await page.screenshot({
    path: path.join(iconsDir, file),
    omitBackground: background === null,
  });
  console.log(`wrote public/icons/${file}`);
}

await browser.close();
