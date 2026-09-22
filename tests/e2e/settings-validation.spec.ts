import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

// Review 2026-09-21 R08: an unknown timezone used to be saved and then throw
// RangeError on every projection page.
test("settings: unknown timezone is refused and the page offers a zone list", async ({ page }) => {
  await ensureAuth(page);
  const current = (await (await page.request.get("/api/settings")).json()) as {
    settings: Record<string, unknown> & { timezone: string };
  };
  const { startingBalanceCents, startingBalanceAsOf, defaultPaycheckCents, firstPaydayDate,
    payFrequencyDays, projectionMonths, currency, timezone } = current.settings;
  const body = { startingBalanceCents, startingBalanceAsOf, defaultPaycheckCents, firstPaydayDate,
    payFrequencyDays, projectionMonths, currency, timezone };

  const bad = await page.request.patch("/api/settings", { data: { ...body, timezone: "Mars/Olympus" } });
  expect(bad.status()).toBe(400);
  const badDate = await page.request.patch("/api/settings", { data: { ...body, startingBalanceAsOf: "2026-99-99" } });
  expect(badDate.status()).toBe(400);

  // Nothing was persisted and the dashboard still renders.
  const after = (await (await page.request.get("/api/settings")).json()) as { settings: { timezone: string } };
  expect(after.settings.timezone).toBe(timezone);
  await page.goto("/");
  await expect(page.locator("[data-app-shell]")).toBeVisible();

  await page.goto("/settings");
  const select = page.getByLabel("Timezone");
  await expect(select).toHaveValue(timezone);
  await expect(select.locator("option[value='America/Los_Angeles']")).toHaveCount(1);
});
