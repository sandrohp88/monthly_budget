import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("one deposit splits across a paycheck and a one-time bonus", async ({ page }) => {
  await ensureAuth(page);

  const payDate = addDaysIso(new Date().toISOString().slice(0, 10), 40);
  const paycheckRes = await page.request.post("/api/paychecks", {
    data: { payDate, amountCents: 1500_00, note: "Payroll" },
  });
  expect(paycheckRes.ok()).toBeTruthy();
  const paycheck = (await paycheckRes.json()).paycheck as { id: string; userId: string };
  const bonusRes = await page.request.post("/api/paychecks", {
    data: { payDate, amountCents: 2000_00, note: "Q3 bonus", isOneTime: true },
  });
  expect(bonusRes.ok()).toBeTruthy();
  const bonus = (await bonusRes.json()).paycheck as { id: string };

  const db = new Database(path.resolve("data/test.db"));
  try {
    db.pragma("foreign_keys = ON");
    const itemId = "e2e-item-income";
    const accountId = "e2e-acct-income";
    db.prepare(
      `INSERT INTO plaid_items (id, user_id, institution_id, institution_name, access_token_enc, access_token_iv, access_token_tag, is_active)
       VALUES (?, ?, 'ins_e2e', 'E2E Bank', '00', '00', '00', 1)`,
    ).run(itemId, paycheck.userId);
    db.prepare(
      `INSERT INTO plaid_accounts (id, item_id, user_id, name, mask, type, subtype, balance_cents, use_as_starting_balance, sync_enabled, updated_at)
       VALUES (?, ?, ?, 'Checking', '4242', 'depository', 'checking', 500000, 1, 1, ?)`,
    ).run(accountId, itemId, paycheck.userId, Date.now());
    db.prepare(
      `INSERT INTO plaid_transaction_drafts (id, user_id, account_id, date, description, original_description, amount_cents, pending, status, kind)
       VALUES ('e2e-dep-combo', ?, ?, ?, 'COMBO PAYROLL', 'COMBO PAYROLL', -350000, 0, 'approved', 'expense')`,
    ).run(paycheck.userId, accountId, payDate);
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }

  await page.goto("/transactions");
  await page.getByLabel("Search transactions").fill("COMBO PAYROLL");
  await page.getByRole("button", { name: "Split across income" }).click();

  const dialog = page.getByRole("dialog", { name: /what income arrived/i });
  // The deposit label is "COMBO PAYROLL", so match the income rows by role.
  await expect(dialog.getByRole("button", { name: /^Payroll\b/ })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Q3 bonus\b/ })).toBeVisible();
  await dialog.getByRole("button", { name: "Add", exact: true }).nth(0).click();
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await dialog.getByRole("button", { name: "Save split" }).click();
  await expect(dialog).toBeHidden();

  const listed = await page.request.get("/api/paychecks");
  expect(listed.ok()).toBeTruthy();
  const rows = (await listed.json()).paychecks as Array<{
    id: string;
    actualReceived: boolean;
    actualAmountCents: number | null;
    settledByDraftId: string | null;
  }>;
  const payRow = rows.find((row) => row.id === paycheck.id);
  const bonusRow = rows.find((row) => row.id === bonus.id);
  expect(payRow).toMatchObject({
    actualReceived: true,
    actualAmountCents: 1500_00,
    settledByDraftId: "e2e-dep-combo",
  });
  expect(bonusRow).toMatchObject({
    actualReceived: true,
    actualAmountCents: 2000_00,
    settledByDraftId: "e2e-dep-combo",
  });
});
