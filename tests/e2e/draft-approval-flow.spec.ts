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
 * Seeds a Plaid item, account, and a still-`pending_review` draft directly
 * into the test DB. Own copy of the idiom in plaid-draft-approval.spec.ts
 * (different ids throughout so the two specs' rows never collide in the
 * shared per-run DB) — but left un-approved, because that spec only ever
 * asserts already-approved drafts render. This spec drives the actual
 * pending_review -> approved transition.
 */
function seedPendingDraft(dbPath: string, draftDate: string, description: string): string {
  const db = new Database(dbPath);
  try {
    const user = db.prepare("SELECT id FROM users LIMIT 1").get() as
      | { id: string }
      | undefined;
    if (!user) throw new Error("No user found — run ensureAuth first");

    const userId = user.id;
    const itemId = "test-plaid-item-review-001";
    const accountId = "test-plaid-account-review-001";
    const draftId = "test-plaid-draft-review-001";

    const existing = db
      .prepare("SELECT id FROM plaid_transaction_drafts WHERE id = ?")
      .get(draftId);
    if (existing) return draftId;

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
       VALUES (?, ?, ?, 'Test Review Checking', '9911', 'depository', 'checking',
               250000, 0, 1, ?)`,
    ).run(accountId, itemId, userId, Date.now());

    db.prepare(
      `INSERT INTO plaid_transaction_drafts
       (id, user_id, account_id, date, description, original_description,
        amount_cents, plaid_category, merchant_name, pending,
        status, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?,
               4275, 'FOOD_AND_DRINK', ?, 0,
               'pending_review', 'expense', ?)`,
    ).run(
      draftId,
      userId,
      accountId,
      draftDate,
      description,
      `${description.toUpperCase()} #4471`,
      description,
      Date.now(),
    );

    db.pragma("foreign_keys = ON");
    return draftId;
  } finally {
    db.close();
  }
}

test("pending-review draft: approving it creates a one-time expense and the draft renders approved", async ({
  page,
}) => {
  await ensureAuth(page);

  const today = new Date().toISOString().slice(0, 10);
  const draftDate = addDaysIso(today, -3);
  const description = "Copper Kettle Coffee Draft Approval";

  const dbPath = path.resolve(process.cwd(), "data", "test.db");
  const draftId = seedPendingDraft(dbPath, draftDate, description);

  // Drive the actual approve transition. The app ships a
  // PlaidDraftApproveDialog component for reviewing pending_review drafts,
  // but nothing currently renders it — /transactions only ever lists
  // status=approved drafts (app/(app)/transactions/page.tsx hardcodes
  // listPlaidDrafts(userId, "approved")), so there is no click-through
  // affordance in the shipped UI to open it. Approving through the same
  // PATCH endpoint that dialog calls exercises the identical server-side
  // transition (draft -> approved, one_time_expense created) without
  // modifying any existing file to wire up the dead component.
  const approveRes = await page.request.patch(`/api/plaid/drafts/${draftId}`, {
    data: { action: "approve" },
  });
  expect(approveRes.ok()).toBe(true);
  const approveJson = (await approveRes.json()) as {
    draft: { status: string };
    expense: { id: string; description: string; amountCents: number };
  };
  expect(approveJson.draft.status).toBe("approved");
  expect(approveJson.expense.description).toBe(description);
  expect(approveJson.expense.amountCents).toBe(4275);

  // Now it renders as an approved transaction — scope to the row's own grid
  // container (tag + class + our distinctive description) so this resolves
  // to exactly one element instead of every ancestor div that happens to
  // contain the text.
  await page.goto("/transactions");
  const txnRow = page.locator("div.grid").filter({ hasText: description });
  await expect(txnRow).toHaveCount(1);
  await expect(txnRow).toContainText("$42.75");

  // … and the one-time expense it created is visible on the extras page too.
  await page.goto("/extras");
  await page.getByRole("button", { name: /all ·/i }).click();
  const extraRow = page.locator("tr").filter({ hasText: description });
  await expect(extraRow).toHaveCount(1);
  await expect(extraRow).toContainText("$42.75");
});
