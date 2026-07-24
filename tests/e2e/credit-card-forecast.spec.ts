import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("card forecast tab shows an upcoming statement in the monthly rollup", async ({ page }) => {
  await ensureAuth(page);

  // Relative dates so the statement always sits in the forward window (the
  // forecast only buckets due dates on/after today).
  const today = new Date().toISOString().slice(0, 10);
  const statementDate = addDaysIso(today, -3);
  const dueDate = addDaysIso(today, 20);

  // ── create a card with a distinctive name + amount ────────────────────
  // The suite shares one DB, so every assertion below is scoped to this card
  // rather than to a page-wide total.
  await page.goto("/credit-cards");
  await page.getByRole("button", { name: /add card/i }).click();

  const cardDialog = page.getByRole("dialog");
  await cardDialog.locator("#cc-name").fill("Forecast Card");
  await cardDialog.locator("#cc-stmt").fill(String(Number(statementDate.slice(8, 10))));
  await cardDialog.locator("#cc-due").fill(String(Number(dueDate.slice(8, 10))));
  await cardDialog.getByRole("button", { name: /add card/i }).click();

  await page.getByRole("link", { name: /forecast card/i }).first().click();
  await expect(page.getByRole("heading", { name: /forecast card/i })).toBeVisible();

  await page.getByRole("button", { name: /enter statement/i }).first().click();
  const stmtDialog = page.getByRole("dialog");
  await stmtDialog.locator("#stmt-date").fill(statementDate);
  await stmtDialog.locator("#due-date").fill(dueDate);
  await stmtDialog.locator("input[inputmode='decimal']").fill("742");
  await stmtDialog.getByRole("button", { name: /save statement/i }).click();
  await expect(page.getByText("$742.00").first()).toBeVisible();

  // ── the forecast tab picks it up ──────────────────────────────────────
  await page.goto("/credit-cards");
  await page.getByRole("button", { name: /^forecast$/i }).click();

  // Per-card breakdown: an unpaid statement with no promos is a firm
  // statement obligation, so it lands in the Statements column.
  // Anchor to the start of the row's accessible name so the month-by-month
  // header row ("Month | Forecast Card | …") doesn't also match.
  const cardRow = page.getByRole("row", { name: /^Forecast Card/ });
  await expect(cardRow).toContainText("$742.00");

  // And it shows up as a column in the month-by-month table.
  await expect(
    page.getByRole("columnheader", { name: /forecast card/i }).first(),
  ).toBeVisible();

  // Switching back to the wallet keeps the card faces.
  await page.getByRole("button", { name: /^wallet$/i }).click();
  await expect(page.getByRole("link", { name: /forecast card/i }).first()).toBeVisible();
});
