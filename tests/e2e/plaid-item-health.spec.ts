import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { ensureAuth } from "./auth";

// Review 2026-11-10 PLAID-2: a broken bank connection must be visible on
// /accounts and, when it feeds the starting balance, on the dashboard.
const ITEM_ID = "item-health-item";
const ACCOUNT_ID = "item-health-account";
const BANK = "Health Check Bank";
const DAY_MS = 86_400_000;

function seedBrokenAnchorItem(dbPath: string) {
  const db = new Database(dbPath);
  try {
    const user = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string } | undefined;
    if (!user) throw new Error("No user found — run ensureAuth first");
    const now = Date.now();
    db.prepare(
      `INSERT OR REPLACE INTO plaid_items
       (id, user_id, institution_id, institution_name,
        access_token_enc, access_token_iv, access_token_tag, is_active, created_at,
        last_synced_at, last_error_code, last_error_at, first_error_at)
       VALUES (?, ?, 'ins_item_health', ?, 'fake_enc_hex', 'fake_iv_hex', 'fake_tag_hex', 1, ?,
               ?, 'ITEM_LOGIN_REQUIRED', ?, ?)`,
    ).run(ITEM_ID, user.id, BANK, now - 30 * DAY_MS, now - 7 * DAY_MS, now - DAY_MS, now - 6 * DAY_MS);
    db.prepare(
      `INSERT OR REPLACE INTO plaid_accounts
       (id, item_id, user_id, name, mask, type, subtype,
        balance_cents, use_as_starting_balance, sync_enabled, updated_at)
       VALUES (?, ?, ?, 'Health Checking', '7777', 'depository', 'checking',
               150000, 1, 1, ?)`,
    ).run(ACCOUNT_ID, ITEM_ID, user.id, now);
  } finally {
    db.close();
  }
}

function cleanup(dbPath: string) {
  const db = new Database(dbPath);
  try {
    db.prepare("DELETE FROM plaid_accounts WHERE id = ?").run(ACCOUNT_ID);
    db.prepare("DELETE FROM plaid_items WHERE id = ?").run(ITEM_ID);
  } finally {
    db.close();
  }
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function expectAccountsWarning(page: Page) {
  await page.goto("/accounts");
  const warning = page.getByRole("group", { name: `${BANK} connection problem` });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("The bank needs you to sign in again");
  await expect(warning).toContainText("Last successful sync");
  await expect(warning).toContainText("unlink this bank");
  // The page-level tile names the broken bank instead of the newest sync.
  await expect(page.getByText(`${BANK} not syncing`)).toBeVisible();
  // Link update mode is not built: no button may pretend to reconnect.
  await expect(page.getByRole("button", { name: /reconnect/i })).toHaveCount(0);
}

async function expectDashboardAlert(page: Page) {
  await page.goto("/");
  const alert = page.getByText(`${BANK} has not synced since`);
  await expect(alert).toBeVisible();
  await expect(page.getByText(/the balance shown may be out of date/i)).toBeVisible();
  // The balance tile keeps its number but no longer claims "live".
  await expect(page.getByText(`· ${BANK} not syncing`)).toBeVisible();
  await expect(page.getByText("live · linked accounts")).toHaveCount(0);
}

test("a broken bank connection is shown on /accounts and the dashboard", async ({ page }) => {
  await ensureAuth(page);
  const dbPath = path.resolve(process.cwd(), "data", "test.db");
  seedBrokenAnchorItem(dbPath);

  try {
    await expectAccountsWarning(page);
    await expectDashboardAlert(page);

    await page.setViewportSize({ width: 375, height: 812 });
    await expectAccountsWarning(page);
    await expectNoHorizontalScroll(page);
    await expectDashboardAlert(page);
    await expectNoHorizontalScroll(page);
  } finally {
    cleanup(dbPath);
  }
});
