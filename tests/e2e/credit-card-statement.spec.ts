import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

test("create card -> enter statement -> mark paid -> verify in projection", async ({ page }) => {
  await ensureAuth(page);

  // ── create a credit card ──────────────────────────────────────────────
  await page.goto("/credit-cards");
  await page.getByRole("button", { name: /add card/i }).click();

  const cardDialog = page.getByRole("dialog");
  await cardDialog.locator("#cc-name").fill("Test Visa");
  await cardDialog.locator("#cc-stmt").fill("15");
  await cardDialog.locator("#cc-due").fill("10");
  await cardDialog.getByRole("button", { name: /add card/i }).click();

  await expect(page.getByText("Test Visa").first()).toBeVisible();

  // ── enter a statement ─────────────────────────────────────────────────
  await page.getByRole("button", { name: /enter statement/i }).first().click();

  const stmtDialog = page.getByRole("dialog");
  await stmtDialog.locator("#stmt-date").fill("2026-05-15");
  await stmtDialog.locator("#due-date").fill("2026-06-10");
  // MoneyInput: type dollar amount (500 = $500.00)
  await stmtDialog.locator("input[inputmode='decimal']").fill("500");
  await stmtDialog.getByRole("button", { name: /save statement/i }).click();

  // statement should appear on the card — look for the balance
  await expect(page.getByText("$500.00").first()).toBeVisible();

  // ── mark the statement as paid ────────────────────────────────────────
  // Click the statement row to open the edit dialog
  await page.getByText("2026-05-15").first().click();

  const editDialog = page.getByRole("dialog");
  await expect(editDialog.getByText(/STATEMENT/i).first()).toBeVisible();
  // Toggle "MARK AS PAID"
  await editDialog.locator("label").filter({ hasText: /mark as paid/i }).click();
  await editDialog.getByRole("button", { name: /save/i }).click();

  // ── verify in projection ──────────────────────────────────────────────
  await page.goto("/projection");
  // The card name should appear in the projection as a payment event
  await expect(page.getByText("Test Visa").first()).toBeVisible();
});
