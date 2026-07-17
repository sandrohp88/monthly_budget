import path from "node:path";
import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Seeds a Plaid item, account, and approved draft transaction directly into
 * the test DB. The Plaid sandbox isn't required — we're testing that the
 * transactions page correctly renders imported data.
 */
function seedPlaidDraft(dbPath: string) {
  const today = new Date().toISOString().slice(0, 10);
  // A recently-posted transaction date, relative to today — the transactions
  // page has no date filter, but a fixed past date reads as stale years on.
  const draftDate = addDaysIso(today, -5);
  const db = new Database(dbPath);
  try {
    const user = db.prepare("SELECT id FROM users LIMIT 1").get() as
      | { id: string }
      | undefined;
    if (!user) throw new Error("No user found — run ensureAuth first");

    const userId = user.id;
    const itemId = "test-plaid-item-001";
    const accountId = "test-plaid-account-001";
    const draftId = "test-plaid-draft-001";

    // Check if already seeded (idempotent)
    const existing = db
      .prepare("SELECT id FROM plaid_transaction_drafts WHERE id = ?")
      .get(draftId);
    if (existing) return;

    db.pragma("foreign_keys = OFF");

    db.prepare(
      `INSERT OR IGNORE INTO plaid_items
       (id, user_id, institution_id, institution_name,
        access_token_enc, access_token_iv, access_token_tag,
        is_active, created_at)
       VALUES (?, ?, 'ins_test', 'Test Bank',
               'fake_enc_hex', 'fake_iv_hex', 'fake_tag_hex',
               1, ?)`,
    ).run(itemId, userId, Date.now());

    db.prepare(
      `INSERT OR IGNORE INTO plaid_accounts
       (id, item_id, user_id, name, mask, type, subtype,
        balance_cents, use_as_starting_balance, sync_enabled, updated_at)
       VALUES (?, ?, ?, 'Test Checking', '4242', 'depository', 'checking',
               500000, 0, 1, ?)`,
    ).run(accountId, itemId, userId, Date.now());

    db.prepare(
      `INSERT INTO plaid_transaction_drafts
       (id, user_id, account_id, date, description, original_description,
        amount_cents, plaid_category, merchant_name, pending,
        status, kind, created_at)
       VALUES (?, ?, ?, ?, 'Whole Foods Market', 'WHOLE FOODS MARKET #10234',
               8750, 'FOOD_AND_DRINK', 'Whole Foods', 0,
               'approved', 'expense', ?)`,
    ).run(draftId, userId, accountId, draftDate, Date.now());

    db.pragma("foreign_keys = ON");
  } finally {
    db.close();
  }
}

test("seeded plaid drafts appear on the transactions page", async ({ page }) => {
  await ensureAuth(page);

  // Seed Plaid data directly into the test DB
  const dbPath = path.resolve(process.cwd(), "data", "test.db");
  seedPlaidDraft(dbPath);

  // ── navigate to transactions ──────────────────────────────────────────
  await page.goto("/transactions");

  // The seeded draft should appear
  await expect(page.getByText("Whole Foods Market").first()).toBeVisible();
  await expect(page.getByText("$87.50").first()).toBeVisible();
  await expect(page.getByText("Test Checking").first()).toBeVisible();
});
