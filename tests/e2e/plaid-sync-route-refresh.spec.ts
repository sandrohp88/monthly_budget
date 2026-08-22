import path from "node:path";
import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { ensureAuth } from "./auth";

const ITEM_ID = "route-refresh-item";
const ACCOUNT_ID = "route-refresh-account";
const CARD_ID = "route-refresh-card";
const CARD_NAME = "Route Refresh Card";

function seedLinkedCard(dbPath: string) {
  const db = new Database(dbPath);
  try {
    const user = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string } | undefined;
    if (!user) throw new Error("No user found — run ensureAuth first");

    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT OR REPLACE INTO plaid_items
       (id, user_id, institution_id, institution_name,
        access_token_enc, access_token_iv, access_token_tag, is_active, created_at)
       VALUES (?, ?, 'ins_route_refresh', 'Refresh Bank',
               'fake_enc_hex', 'fake_iv_hex', 'fake_tag_hex', 1, ?)`,
    ).run(ITEM_ID, user.id, Date.now());
    db.prepare(
      `INSERT OR REPLACE INTO plaid_accounts
       (id, item_id, user_id, name, mask, type, subtype,
        balance_cents, use_as_starting_balance, sync_enabled, updated_at)
       VALUES (?, ?, ?, 'Refresh Card', '4242', 'credit', 'credit card',
               11111, 0, 1, ?)`,
    ).run(ACCOUNT_ID, ITEM_ID, user.id, Date.now());
    db.prepare(
      `INSERT OR REPLACE INTO credit_cards
       (id, user_id, name, statement_day, statement_cycle_mode,
        statement_cycle_interval_days, due_day, grace_period_days,
        current_balance_cents, auto_pay, is_active, plaid_account_id,
        created_at, updated_at)
       VALUES (?, ?, ?, 15, 'calendar_day', 31, 28, 14,
               NULL, 0, 1, ?, ?, ?)`,
    ).run(CARD_ID, user.id, CARD_NAME, ACCOUNT_ID, Date.now(), Date.now());
    db.pragma("foreign_keys = ON");
  } finally {
    db.close();
  }
}

function updateSyncedBalance(dbPath: string, balanceCents: number) {
  const db = new Database(dbPath);
  try {
    db.prepare(
      "UPDATE plaid_accounts SET balance_cents = ?, updated_at = ? WHERE id = ?",
    ).run(balanceCents, Date.now(), ACCOUNT_ID);
  } finally {
    db.close();
  }
}

function cleanup(dbPath: string) {
  const db = new Database(dbPath);
  try {
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM credit_cards WHERE id = ?").run(CARD_ID);
    db.prepare("DELETE FROM plaid_items WHERE id = ?").run(ITEM_ID);
    db.pragma("foreign_keys = ON");
  } finally {
    db.close();
  }
}

test("Plaid sync buttons invalidate data cached for other pages", async ({ page }) => {
  await ensureAuth(page);
  const dbPath = path.resolve(process.cwd(), "data", "test.db");
  seedLinkedCard(dbPath);

  try {
    // Visit the destination first so its server payload is present in the
    // client router cache before the simulated Plaid sync changes the DB.
    await page.goto("/credit-cards");
    const card = page.getByRole("link", { name: new RegExp(CARD_NAME, "i") });
    await expect(card).toContainText("$111.11");

    await page.getByRole("link", { name: /^accounts/i }).first().click();
    await page.waitForURL("**/accounts");

    let syncCount = 0;
    await page.route("**/api/plaid/sync", async (route) => {
      syncCount += 1;
      updateSyncedBalance(dbPath, syncCount === 1 ? 22222 : 33333);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ added: 1, modified: 0 }),
      });
    });

    await page.getByRole("button", { name: /sync now/i }).click();
    await expect(page.getByText(/sync complete/i)).toBeVisible();

    await page.getByRole("link", { name: /^credit cards/i }).first().click();
    await page.waitForURL("**/credit-cards");
    await expect(page.getByRole("link", { name: new RegExp(CARD_NAME, "i") })).toContainText(
      "$222.22",
    );

    // The Transactions page exposes the same sync operation and must clear
    // the same cross-page cache after updating its own local transaction list.
    await page.getByRole("link", { name: /^transactions/i }).first().click();
    await page.waitForURL("**/transactions");
    await page.getByRole("button", { name: /sync now/i }).click();
    await expect(page.getByText(/sync complete/i)).toBeVisible();

    await page.getByRole("link", { name: /^credit cards/i }).first().click();
    await page.waitForURL("**/credit-cards");
    await expect(page.getByRole("link", { name: new RegExp(CARD_NAME, "i") })).toContainText(
      "$333.33",
    );
  } finally {
    cleanup(dbPath);
  }
});
