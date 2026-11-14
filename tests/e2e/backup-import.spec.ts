import { test, expect, type Page } from "@playwright/test";
import { ensureAuth } from "./auth";

type BackupFile = { name: string; mimeType: string; buffer: Buffer };

// Opening the chooser through the button proves its React handler is ready.
// Retry a click lost before hydration; choosing a file only previews data.
async function selectBackup(page: Page, file: BackupFile) {
  const dialog = page.getByRole("dialog", { name: /replace your data with this backup/i });
  await expect(async () => {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 3_000 }),
      page.getByRole("button", { name: /import json/i }).click(),
    ]);
    await chooser.setFiles(file);
    await expect(dialog).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
}

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

  // Preview, then cancel: the new bill must survive.
  await selectBackup(page, file);
  const dialog = page.getByRole("dialog", { name: /replace your data with this backup/i });
  await expect(dialog.getByRole("heading", { name: /replace your data/i })).toBeVisible();
  const billsRow = dialog.getByRole("row", { name: /^bills\b/i });
  await expect(billsRow).toBeVisible();
  await dialog.getByRole("button", { name: /cancel/i }).click();
  await expect(dialog).toBeHidden();
  await page.goto("/bills");
  await expect(page.getByText(billName)).toBeVisible();

  // Confirm: data is restored to the exported state.
  await page.goto("/settings");
  await selectBackup(page, file);
  const restored = page.waitForResponse(
    (response) => response.url().endsWith("/api/backup/import?confirm=1") &&
      response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: /replace my data/i }).click();
  expect((await restored).ok()).toBe(true);
  await expect(dialog).toBeHidden();
  await page.goto("/bills");
  await expect(page.getByText(billName)).toHaveCount(0);
});
