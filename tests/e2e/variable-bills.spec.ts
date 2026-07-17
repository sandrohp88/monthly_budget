import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

test("variable bill: create via UI, links to a card, appears in the variable-bills list with its amount", async ({
  page,
}) => {
  await ensureAuth(page);

  const cardRes = await page.request.post("/api/credit-cards", {
    data: {
      name: "Variable Bills Test Card",
      statementDay: 5,
      statementCycleMode: "calendar_day",
      statementCycleIntervalDays: 31,
      dueDay: 20,
      autoPay: false,
    },
  });
  expect(cardRes.ok()).toBe(true);

  await page.goto("/bills");
  await page.getByRole("button", { name: /add variable/i }).first().click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /add variable bill/i })).toBeVisible();

  await dialog.locator("#variable-name").fill("Grocery Variable Test Bill");
  await dialog.locator("input[inputmode='decimal']").fill("245.67");
  // Leave category/interval/anchor-date at their defaults — only the card
  // link and amount matter for this spec's assertions. Make sure our new
  // card is checked regardless of whatever the form pre-selected by default.
  await dialog.getByLabel(/variable bills test card/i).check();
  await dialog.getByRole("button", { name: /^save$/i }).click();

  await expect(dialog).toBeHidden();

  const billRow = page.locator("tr").filter({ hasText: "Grocery Variable Test Bill" });
  await expect(billRow).toHaveCount(1);
  await expect(billRow).toContainText("$245.67");
  await expect(billRow).toContainText("Variable Bills Test Card");
  await expect(billRow).toContainText(/monthly/i);
});
