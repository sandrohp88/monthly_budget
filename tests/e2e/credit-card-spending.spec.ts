import path from "node:path";
import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const ITEM_ID = "spend-item-001";
const ACCOUNT_ID = "spend-account-001";
const CARD_NAME = "Spending Test Card";

/**
 * Seeds a linked credit card with posted charges inside its open cycle. The
 * Plaid sandbox isn't involved — the spending tab reads stored drafts, so
 * inserting them directly is the same shape a real sync produces.
 *
 * Statement day is set from today so `currentCycleWindow` puts the seeded
 * charges inside the open cycle no matter when the suite runs.
 */
function seedLinkedCardWithCharges(dbPath: string, today: string) {
  const db = new Database(dbPath);
  try {
    const user = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string } | undefined;
    if (!user) throw new Error("No user found — run ensureAuth first");
    const userId = user.id;
    if (db.prepare("SELECT id FROM plaid_accounts WHERE id = ?").get(ACCOUNT_ID)) return;

    db.pragma("foreign_keys = OFF");

    db.prepare(
      `INSERT OR IGNORE INTO plaid_items
       (id, user_id, institution_id, institution_name,
        access_token_enc, access_token_iv, access_token_tag, is_active, created_at)
       VALUES (?, ?, 'ins_spend', 'Spend Bank',
               'fake_enc_hex', 'fake_iv_hex', 'fake_tag_hex', 1, ?)`,
    ).run(ITEM_ID, userId, Date.now());

    // balance 400.00 against a 1,000.00 line -> 40%, the "moderate" band.
    db.prepare(
      `INSERT OR IGNORE INTO plaid_accounts
       (id, item_id, user_id, name, mask, type, subtype,
        balance_cents, limit_cents, use_as_starting_balance, sync_enabled, updated_at)
       VALUES (?, ?, ?, 'Spend Card', '7788', 'credit', 'credit card',
               40000, 100000, 0, 1, ?)`,
    ).run(ACCOUNT_ID, ITEM_ID, userId, Date.now());

    // Cycle closes 10 days out, so charges dated in the last few days land
    // inside the open window.
    const cardId = "spend-card-001";
    const closeDay = Number(addDaysIso(today, 10).slice(8, 10));
    const dueDay = ((closeDay + 14) % 28) + 1;
    db.prepare(
      `INSERT OR IGNORE INTO credit_cards
       (id, user_id, name, statement_day, statement_cycle_mode,
        statement_cycle_interval_days, due_day, grace_period_days,
        current_balance_cents, credit_limit_cents, auto_pay, is_active,
        plaid_account_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'calendar_day', 31, ?, 14, 40000, 100000, 0, 1, ?, ?, ?)`,
    ).run(cardId, userId, CARD_NAME, closeDay, dueDay, ACCOUNT_ID, Date.now(), Date.now());

    const insert = db.prepare(
      `INSERT OR IGNORE INTO plaid_transaction_drafts
       (id, user_id, account_id, date, description, original_description,
        amount_cents, plaid_category, merchant_name, pending, status, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'approved', 'expense', ?)`,
    );
    const charges: Array<[string, string, number, string, number]> = [
      ["spend-txn-1", "Big Box Store", 210_00, "GENERAL_MERCHANDISE", -2],
      ["spend-txn-2", "Corner Grocery", 45_50, "FOOD_AND_DRINK", -3],
      // A payment toward the card, stored as `expense` the way legacy rows are.
      // It must NOT count as spend, or the cycle total nets down.
      ["spend-txn-3", "ONLINE PAYMENT, THANK YOU", -300_00, "LOAN_PAYMENTS", -4],
    ];
    for (const [id, desc, cents, category, dayOffset] of charges) {
      insert.run(
        id,
        userId,
        ACCOUNT_ID,
        addDaysIso(today, dayOffset),
        desc,
        desc,
        cents,
        category,
        desc,
        Date.now(),
      );
    }

    db.pragma("foreign_keys = ON");
  } finally {
    db.close();
  }
}

test("spending tab shows cycle charges and utilization from transactions", async ({ page }) => {
  await ensureAuth(page);

  const today = new Date().toISOString().slice(0, 10);
  seedLinkedCardWithCharges(path.resolve(process.cwd(), "data", "test.db"), today);

  await page.goto("/credit-cards");
  await page.getByRole("button", { name: /^spending$/i }).click();

  await expect(page.getByRole("link", { name: CARD_NAME })).toBeVisible();

  // The suite shares one DB, so assertions lean on values only this card's
  // seed produces rather than on DOM nesting (which the card panel's wrapper
  // divs make brittle to scope).
  // 210.00 + 45.50 — the -300.00 payment is excluded, not netted.
  await expect(page.getByText("$255.50").first()).toBeVisible();
  await expect(page.getByText(/2 charges this cycle/i)).toBeVisible();

  // Utilization: 400 of 1,000.
  await expect(page.getByText("40% used")).toBeVisible();
  await expect(page.getByText(/\$600\.00 left before the limit/)).toBeVisible();

  // The charge detail is collapsed until asked for. "Big Box Store" is a poor
  // probe — it also shows collapsed, as the "biggest charge" hint. The second
  // charge only exists in the expanded list.
  await expect(page.getByText("Corner Grocery")).toHaveCount(0);
  await page.getByRole("button", { name: /show charges/i }).first().click();
  await expect(page.getByText("Corner Grocery").first()).toBeVisible();
  await expect(page.getByText("General merchandise").first()).toBeVisible();
  // The excluded payment never shows up as a charge.
  await expect(page.getByText("ONLINE PAYMENT, THANK YOU")).toHaveCount(0);
});
