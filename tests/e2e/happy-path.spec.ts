import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

// Locators use case-insensitive regex so copy casing tweaks do not silently
// break the suite.

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("setup -> add a bill -> add an extra -> see them in projection", async ({ page }) => {
  await ensureAuth(page);

  // Due date relative to today — a fixed past date would eventually just
  // re-anchor onto next month's recurrence (harmless), but relativizing keeps
  // the fixture testing the same "upcoming due date" path every run.
  const today = new Date().toISOString().slice(0, 10);
  const dueDate = addDaysIso(today, 14);

  await page.goto("/bills");
  await page.getByRole("button", { name: /^ADD BILL$/i }).click();
  const billDialog = page.getByRole("dialog", { name: /add bill/i });
  await billDialog.getByLabel(/^name$/i).fill("Rent");
  await billDialog.getByLabel(/amount/i).fill("700");
  await billDialog.getByLabel(/next due date/i).fill(dueDate);
  await billDialog.getByRole("button", { name: /^save$/i }).click();
  await expect(page.getByText("Rent").first()).toBeVisible();

  await page.goto("/extras");
  await page.getByRole("button", { name: /^ADD EXPENSE$/i }).first().click();
  const extraDialog = page.getByRole("dialog", { name: /add expense/i });
  await extraDialog.getByLabel(/description/i).fill("Concert tickets");
  await extraDialog.getByLabel(/amount/i).fill("90");
  await extraDialog.getByRole("button", { name: /^save$/i }).click();
  await expect(page.getByText("Concert tickets").first()).toBeVisible();

  await page.goto("/ledger");
  await expect(page.getByText("Rent").first()).toBeVisible();
  await expect(page.getByText("Concert tickets").first()).toBeVisible();
});

// Smoke test for unauthenticated routes — verifies the app boots, the prod
// build is sane, and the login page renders. No NextAuth session required.
test("app boots: /setup or /login renders", async ({ page }) => {
  // Either /setup (fresh DB) or /login (existing user) is acceptable —
  // we just need the prod build to be alive.
  await page.goto("/");
  // Middleware redirects unauth users; we should land on /setup or /login.
  await page.waitForURL(/\/(setup|login)/);
  // Bluefalls branding is on every entry screen (login and setup).
  await expect(page.getByText(/Bluefalls finance/i).first()).toBeVisible();
});
