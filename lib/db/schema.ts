import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";


/**
 * All money stored as integer cents. All dates stored as ISO YYYY-MM-DD strings (TEXT).
 * createdAt/updatedAt stored as unix millis (INTEGER).
 */

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    emailUnique: uniqueIndex("users_email_unique").on(t.email),
  }),
);

export const settings = sqliteTable("settings", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  startingBalanceCents: integer("starting_balance_cents").notNull().default(0),
  defaultPaycheckCents: integer("default_paycheck_cents").notNull().default(0),
  firstPaydayDate: text("first_payday_date").notNull(),
  payFrequencyDays: integer("pay_frequency_days").notNull().default(14),
  projectionMonths: integer("projection_months").notNull().default(6),
  currency: text("currency").notNull().default("USD"),
  timezone: text("timezone").notNull().default("America/New_York"),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
});

export const paychecks = sqliteTable(
  "paychecks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    payDate: text("pay_date").notNull(),
    amountCents: integer("amount_cents").notNull(),
    note: text("note"),
    actualReceived: integer("actual_received", { mode: "boolean" }).notNull().default(false),
    actualAmountCents: integer("actual_amount_cents"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userDate: index("paychecks_user_date_idx").on(t.userId, t.payDate),
  }),
);

export const bills = sqliteTable(
  "bills",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: text("category").notNull(),
    amountCents: integer("amount_cents").notNull(),
    frequency: text("frequency", { enum: ["monthly", "annual"] }).notNull(),
    dueDay: integer("due_day").notNull(),
    dueMonth: integer("due_month"),
    autoPay: integer("auto_pay", { mode: "boolean" }).notNull().default(false),
    /**
     * If set, this bill is paid by the referenced credit card and should NOT
     * deduct from cash on its due date — the card's statement payment will
     * carry it. Falls back to cash if the linked card is archived (so we never
     * silently lose money in the projection).
     */
    paidViaCardId: text("paid_via_card_id"),
    notes: text("notes"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userActive: index("bills_user_active_idx").on(t.userId, t.isActive),
  }),
);

export const oneTimeExpenses = sqliteTable(
  "one_time_expenses",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    description: text("description").notNull(),
    amountCents: integer("amount_cents").notNull(),
    category: text("category").notNull(),
    notes: text("notes"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userDate: index("extras_user_date_idx").on(t.userId, t.date),
  }),
);

/**
 * Credit cards have a billing cycle with TWO dates that matter:
 *   - statementDay: day of month the statement closes (everything before is on this bill)
 *   - dueDay: day of month payment is due to avoid interest
 * Per-cycle data lives in credit_card_statements; the card row is persistent config.
 */
export const creditCards = sqliteTable(
  "credit_cards",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    statementDay: integer("statement_day").notNull(),
    dueDay: integer("due_day").notNull(),
    autoPay: integer("auto_pay", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    /**
     * Optional link to a Plaid account. When set, sync auto-populates this card's
     * cycle days + most recent statement from Plaid Liabilities. Nulled by app
     * code when the Plaid item is unlinked (SQLite ALTER TABLE can't add FKs,
     * so referential integrity is enforced in `deactivatePlaidItem`).
     */
    plaidAccountId: text("plaid_account_id"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userActive: index("credit_cards_user_active_idx").on(t.userId, t.isActive),
    plaidAccountUnique: uniqueIndex("credit_cards_plaid_account_unique_idx").on(t.plaidAccountId),
  }),
);

export const creditCardStatements = sqliteTable(
  "credit_card_statements",
  {
    id: text("id").primaryKey(),
    cardId: text("card_id")
      .notNull()
      .references(() => creditCards.id, { onDelete: "cascade" }),
    statementDate: text("statement_date").notNull(),
    dueDate: text("due_date").notNull(),
    statementBalanceCents: integer("statement_balance_cents").notNull(),
    paidAmountCents: integer("paid_amount_cents"),
    paidDate: text("paid_date"),
    notes: text("notes"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    cardDue: index("cc_statements_card_due_idx").on(t.cardId, t.dueDate),
    cardDateUnique: uniqueIndex("cc_statements_card_date_unique_idx").on(t.cardId, t.statementDate),
  }),
);

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull(),
  kind: text("kind", { enum: ["expense", "income"] }).notNull(),
});

export type UserRow = typeof users.$inferSelect;
export type UserSafe = Omit<UserRow, "passwordHash">;
export type SettingsRow = typeof settings.$inferSelect;
export type PaycheckRow = typeof paychecks.$inferSelect;
export type BillRow = typeof bills.$inferSelect;
export type OneTimeExpenseRow = typeof oneTimeExpenses.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type CreditCardRow = typeof creditCards.$inferSelect;
export type CreditCardStatementRow = typeof creditCardStatements.$inferSelect;

export type NewUser = typeof users.$inferInsert;
export type NewSettings = typeof settings.$inferInsert;
export type NewPaycheck = typeof paychecks.$inferInsert;
export type NewBill = typeof bills.$inferInsert;
export type NewOneTimeExpense = typeof oneTimeExpenses.$inferInsert;
export type NewCategory = typeof categories.$inferInsert;
export type NewCreditCard = typeof creditCards.$inferInsert;
export type NewCreditCardStatement = typeof creditCardStatements.$inferInsert;

// ── Plaid ─────────────────────────────────────────────────────────────────────

/**
 * One row per Plaid Item (= one institution login).
 * The access_token is stored AES-256-GCM encrypted; the plaintext NEVER hits the DB.
 *   access_token_enc = hex-encoded ciphertext
 *   access_token_iv  = hex-encoded 12-byte IV
 *   access_token_tag = hex-encoded 16-byte GCM auth tag
 */
export const plaidItems = sqliteTable(
  "plaid_items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    institutionId: text("institution_id").notNull(),
    institutionName: text("institution_name").notNull(),
    accessTokenEnc: text("access_token_enc").notNull(),
    accessTokenIv: text("access_token_iv").notNull(),
    accessTokenTag: text("access_token_tag").notNull(),
    cursor: text("cursor"),
    lastSyncedAt: integer("last_synced_at"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userActive: index("plaid_items_user_active_idx").on(t.userId, t.isActive),
  }),
);

/**
 * One row per Plaid Account (e.g. “Chase Checking ****4242”).
 * id = Plaid’s account_id string (NOT nanoid).
 * Many accounts can belong to one item (one institution login).
 */
export const plaidAccounts = sqliteTable(
  "plaid_accounts",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => plaidItems.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mask: text("mask"),
    type: text("type").notNull(),
    subtype: text("subtype"),
    balanceCents: integer("balance_cents"),
    /** If true, this account’s live balance overrides startingBalanceCents in the projection. */
    useAsStartingBalance: integer("use_as_starting_balance", { mode: "boolean" })
      .notNull()
      .default(false),
    syncEnabled: integer("sync_enabled", { mode: "boolean" }).notNull().default(true),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    itemIdx: index("plaid_accounts_item_idx").on(t.itemId),
    userIdx: index("plaid_accounts_user_idx").on(t.userId),
  }),
);

/**
 * Transactions imported from Plaid, awaiting user review.
 * id = Plaid’s transaction_id (string) — upsert is idempotent.
 * amountCents convention: positive = debit/expense, negative = credit/refund.
 * status flow: pending_review → approved | dismissed.
 */
export const plaidTransactionDrafts = sqliteTable(
  "plaid_transaction_drafts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => plaidAccounts.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    description: text("description").notNull(),
    amountCents: integer("amount_cents").notNull(),
    plaidCategory: text("plaid_category"),
    merchantName: text("merchant_name"),
    pending: integer("pending", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: ["pending_review", "approved", "dismissed"] })
      .notNull()
      .default("pending_review"),
    linkedExpenseId: text("linked_expense_id"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userStatus: index("plaid_drafts_user_status_idx").on(t.userId, t.status),
    accountIdx: index("plaid_drafts_account_idx").on(t.accountId),
  }),
);

export type PlaidItemRow = typeof plaidItems.$inferSelect;
export type PlaidAccountRow = typeof plaidAccounts.$inferSelect;
export type PlaidTransactionDraftRow = typeof plaidTransactionDrafts.$inferSelect;
export type NewPlaidItem = typeof plaidItems.$inferInsert;
export type NewPlaidAccount = typeof plaidAccounts.$inferInsert;
export type NewPlaidTransactionDraft = typeof plaidTransactionDrafts.$inferInsert;
