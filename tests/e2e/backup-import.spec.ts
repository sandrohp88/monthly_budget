import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

// Review 2026-09-21 R02: choosing a file must never replace data on its own.
test("backup import: rejects non-backups, previews, and only replaces on confirm", async ({
  page,
}) => {
  await ensureAuth(page);

  // An empty or unrelated JSON body is not a backup — 400, nothing written.
  const empty = await page.request.post("/api/backup/import", { data: {} });
  expect(empty.status()).toBe(400);

  const exportRes = await page.request.get("/api/backup/export");
  expect(exportRes.ok()).toBe(true);
  const backup = await exportRes.json();

  const billName = `Import Spec Bill ${Date.now()}`;
  const billRes = await page.request.post("/api/bills", {
    data: {
      name: billName,
      category: "Other",
      amountCents: 4321,
      intervalMonths: 1,
      anchorDate: "2026-09-01",
    },
  });
  expect(billRes.ok()).toBe(true);

  const file = {
    name: "budget-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  };

  await page.goto("/settings");
  const picker = page.locator("input[type='file'][accept='application/json']");

  // Preview, then cancel: the new bill must survive.
  await picker.setInputFiles(file);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /replace your data/i })).toBeVisible();
  const billsRow = dialog.getByRole("row", { name: /^bills\b/i });
  await expect(billsRow).toBeVisible();
  await dialog.getByRole("button", { name: /cancel/i }).click();
  await expect(dialog).toBeHidden();
  await page.goto("/bills");
  await expect(page.getByText(billName)).toBeVisible();

  // Confirm: data is restored to the exported state.
  await page.goto("/settings");
  await picker.setInputFiles(file);
  await dialog.getByRole("button", { name: /replace my data/i }).click();
  await page.waitForLoadState("load");
  await page.goto("/bills");
  await expect(page.getByText(billName)).toHaveCount(0);
});
