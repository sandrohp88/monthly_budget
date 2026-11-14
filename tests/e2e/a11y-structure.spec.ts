import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

// Structural a11y on the dashboard. Reuses ensureAuth / saved storageState —
// never a fresh credential POST (the suite already spends the rate-limit burst).

test("dashboard has skip link, heading levels, named navs, and scoped table headers", async ({
  page,
}) => {
  await ensureAuth(page);
  await page.goto("/");
  await expect(page.locator("[data-app-shell]")).toBeVisible();

  // Skip link is the first tab stop and moves focus to <main>.
  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: /skip to main content/i });
  await expect(skipLink).toBeFocused();
  await skipLink.press("Enter");
  await expect(page.locator("main#main-content")).toBeFocused();

  // One page title (h1) and at least one section title (h2 from CardTitle).
  await expect(page.locator("h1")).toHaveCount(1);
  expect(await page.locator("h2").count()).toBeGreaterThanOrEqual(1);

  // Every <nav> in the DOM has a distinct accessible name. (The mobile sheet
  // nav mounts only while open; sidebar + tab bar are always present.)
  const navNames = await page.locator("nav").evaluateAll((navs) =>
    navs.map((nav) => nav.getAttribute("aria-label")?.trim() ?? ""),
  );
  expect(navNames.length).toBeGreaterThanOrEqual(2);
  expect(navNames.every((name) => name.length > 0)).toBe(true);
  expect(new Set(navNames).size).toBe(navNames.length);

  // Shared TableHead defaults scope="col".
  const scopedHeader = page.locator("th[scope='col']").first();
  await expect(scopedHeader).toBeVisible();
});
