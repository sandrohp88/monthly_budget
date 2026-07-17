import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("create card -> add deferred-interest promo -> verify promo chunk in projection", async ({ page }) => {
  await ensureAuth(page);

  // Relative to today so the promo stays inside its normal monthly-schedule
  // window rather than drifting past endDate into the (differently-tested)
  // expired-promo catch-up path as real time passes.
  const today = new Date().toISOString().slice(0, 10);
  const startDate = addDaysIso(today, -14);
  const endDate = addDaysIso(today, 365);

  // ── create a credit card ──────────────────────────────────────────────
  await page.goto("/credit-cards");
  await page.getByRole("button", { name: /add card/i }).click();

  const cardDialog = page.getByRole("dialog");
  await cardDialog.locator("#cc-name").fill("Promo Card");
  await cardDialog.locator("#cc-stmt").fill("20");
  await cardDialog.locator("#cc-due").fill("5");
  await cardDialog.getByRole("button", { name: /add card/i }).click();

  await expect(page.getByText("Promo Card").first()).toBeVisible();

  // Open the card's detail page — statements, promos, and payment planning
  // live there (the wallet list only shows the card face).
  await page.getByRole("link", { name: /promo card/i }).first().click();
  await expect(page.getByRole("heading", { name: /promo card/i })).toBeVisible();

  // ── add a deferred-interest promo ─────────────────────────────────────
  // The promo action is the add button in the card's promo section.
  await page.getByRole("button", { name: /^add$/i }).first().click();

  const promoDialog = page.getByRole("dialog");
  await expect(promoDialog.getByText(/ADD DEFERRED-INTEREST PROMO/i)).toBeVisible();

  await promoDialog.locator("#promo-desc").fill("MacBook Pro Installments");

  // Original amount ($1,200) — first MoneyInput
  const moneyInputs = promoDialog.locator("input[inputmode='decimal']");
  await moneyInputs.first().fill("1200");
  // Remaining ($1,200) — second MoneyInput
  await moneyInputs.nth(1).fill("1200");

  // Start date
  const dateInputs = promoDialog.locator("input[type='date']");
  await dateInputs.first().fill(startDate);
  // End date (12 months out)
  await dateInputs.nth(1).fill(endDate);

  await promoDialog.getByRole("button", { name: /add promo/i }).click();

  // Promo should appear on the card
  await expect(page.getByText("MacBook Pro Installments").first()).toBeVisible();
  await expect(page.getByText("$1,200.00").first()).toBeVisible();

  // ── verify promo chunk appears in projection ──────────────────────────
  await page.goto("/ledger");
  // The promo description should show up as a projected charge
  await expect(page.getByText(/MacBook Pro/i).first()).toBeVisible();
});
