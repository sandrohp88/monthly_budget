import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

test("create card -> add deferred-interest promo -> verify promo chunk in projection", async ({ page }) => {
  await ensureAuth(page);

  // ── create a credit card ──────────────────────────────────────────────
  await page.goto("/credit-cards");
  await page.getByRole("button", { name: /add card/i }).click();

  const cardDialog = page.getByRole("dialog");
  await cardDialog.locator("#cc-name").fill("Promo Card");
  await cardDialog.locator("#cc-stmt").fill("20");
  await cardDialog.locator("#cc-due").fill("5");
  await cardDialog.getByRole("button", { name: /add card/i }).click();

  await expect(page.getByText("Promo Card").first()).toBeVisible();

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
  await dateInputs.first().fill("2026-05-01");
  // End date (12 months out)
  await dateInputs.nth(1).fill("2027-05-01");

  await promoDialog.getByRole("button", { name: /add promo/i }).click();

  // Promo should appear on the card
  await expect(page.getByText("MacBook Pro Installments").first()).toBeVisible();
  await expect(page.getByText("$1,200.00").first()).toBeVisible();

  // ── verify promo chunk appears in projection ──────────────────────────
  await page.goto("/ledger");
  // The promo description should show up as a projected charge
  await expect(page.getByText(/MacBook Pro/i).first()).toBeVisible();
});
