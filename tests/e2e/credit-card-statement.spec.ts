import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("create card -> enter statement -> mark paid -> verify paid state", async ({ page }) => {
  await ensureAuth(page);

  // Dates are relative to today so "mark paid now" always lands on/before the
  // due date (hardcoded dates rotted once the calendar passed them).
  const today = new Date().toISOString().slice(0, 10);
  const statementDate = addDaysIso(today, -7);
  const dueDate = addDaysIso(today, 7);

  // ── create a credit card ──────────────────────────────────────────────
  await page.goto("/credit-cards");
  await page.getByRole("button", { name: /add card/i }).click();

  const cardDialog = page.getByRole("dialog");
  await cardDialog.locator("#cc-name").fill("Test Visa");
  await cardDialog.locator("#cc-stmt").fill(String(Number(statementDate.slice(8, 10))));
  await cardDialog.locator("#cc-due").fill(String(Number(dueDate.slice(8, 10))));
  await cardDialog.getByRole("button", { name: /add card/i }).click();

  await expect(page.getByText("Test Visa").first()).toBeVisible();

  // Open the card detail page — statement entry and payment actions live
  // there (the wallet list only shows the card face).
  await page.getByRole("link", { name: /test visa/i }).first().click();
  await expect(page.getByRole("heading", { name: /test visa/i })).toBeVisible();

  // ── enter a statement ─────────────────────────────────────────────────
  await page.getByRole("button", { name: /enter statement/i }).first().click();

  const stmtDialog = page.getByRole("dialog");
  await stmtDialog.locator("#stmt-date").fill(statementDate);
  await stmtDialog.locator("#due-date").fill(dueDate);
  // MoneyInput: type dollar amount (500 = $500.00)
  await stmtDialog.locator("input[inputmode='decimal']").fill("500");
  await stmtDialog.getByRole("button", { name: /save statement/i }).click();

  // statement should appear on the card — look for the balance
  await expect(page.getByText("$500.00").first()).toBeVisible();

  // ── mark the statement as paid ────────────────────────────────────────
  // Use the explicit statement action; the visual card now renders friendly
  // dates instead of the raw ISO statement date.
  await page.getByRole("button", { name: /mark paid/i }).click();

  const editDialog = page.getByRole("dialog");
  await expect(editDialog.getByText(/STATEMENT/i).first()).toBeVisible();
  // Toggle "Mark as paid"
  await editDialog.getByRole("switch", { name: /mark as paid/i }).click();
  await editDialog.getByRole("button", { name: /save/i }).click();
  await expect(editDialog).toBeHidden();

  // ── verify paid state ─────────────────────────────────────────────────
  await expect(page.getByText(/last paid/i).first()).toBeVisible();
  await expect(page.getByText(/on time/i).first()).toBeVisible();

  // Paid statements should no longer appear as payable ledger events. Scope
  // the check to THIS card: the suite shares one per-run DB, so earlier specs
  // leave their own events behind, and this card's estimated future cycles
  // render as "Test Visa (est.)" — only the exact unpaid-due label counts.
  await page.goto("/ledger");
  await expect(page.getByText("Test Visa", { exact: true })).toHaveCount(0);
});
