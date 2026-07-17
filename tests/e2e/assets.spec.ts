import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

test("asset: add via UI, appears with its value, edit updates value and the net-worth tile", async ({
  page,
}) => {
  await ensureAuth(page);

  await page.goto("/assets");
  await page.getByRole("button", { name: /add asset/i }).first().click();

  const createDialog = page.getByRole("dialog");
  await expect(createDialog.getByRole("heading", { name: /add asset/i })).toBeVisible();
  await createDialog.locator("#name").fill("Vintage Guitar Asset E2E");
  await createDialog.locator("input[inputmode='decimal']").fill("812.34");
  await createDialog.getByRole("button", { name: /^save$/i }).click();
  await expect(createDialog).toBeHidden();

  const assetRow = page.locator("tr").filter({ hasText: "Vintage Guitar Asset E2E" });
  await expect(assetRow).toHaveCount(1);
  await expect(assetRow).toContainText("$812.34");

  // "Total assets" tile — this spec is the only one in the suite that ever
  // creates an asset, so the tile's total is exactly this asset's value.
  const totalTile = page.locator("div.rounded-lg").filter({ hasText: "Total assets" });
  await expect(totalTile).toContainText("$812.34");

  // Edit the asset and confirm both the row and the net-worth tile update.
  await assetRow.getByRole("button", { name: "Edit" }).click();
  const editDialog = page.getByRole("dialog");
  await expect(editDialog.getByRole("heading", { name: /edit asset/i })).toBeVisible();
  await editDialog.locator("input[inputmode='decimal']").fill("999.99");
  await editDialog.getByRole("button", { name: /^save$/i }).click();
  await expect(editDialog).toBeHidden();

  await expect(assetRow).toContainText("$999.99");
  await expect(assetRow).not.toContainText("$812.34");
  await expect(totalTile).toContainText("$999.99");
});
