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
    /**
     * Cycle length in months. 1=monthly, 3=quarterly, 6=semiannual, 12=annual,
     * any positive integer otherwise (e.g. 2=every 2 months, 24=every 2 years).
     */
    intervalMonths: integer("interval_months").notNull(),
    /**
     * One known occurrence of this bill (ISO YYYY-MM-DD). The projection engine
     * generates all other occurrences by adding/subtracting `intervalMonths`
     * from this date, day-clamping to each target month's length.
     * The day-of-month encoded here is the "intended" due day.
     */
    anchorDate: text("anchor_date").notNull(),
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

/**
 * Per-occurrence planned bill payments. This lets a user keep the normal
 * recurring bill amount intact while adjusting one projected cycle when cash
 * is tight. Keyed by bill + dueDate because due dates are generated.
 */
export const billPaymentOverrides = sqliteTable(
  "bill_payment_overrides",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    billId: text("bill_id")
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    dueDate: text("due_date").notNull(),
    amountCents: integer("amount_cents").notNull(),
    notes: text("notes"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userDate: index("bill_payment_overrides_user_date_idx").on(t.userId, t.dueDate),
    billDateUnique: uniqueIndex("bill_payment_overrides_bill_date_unique_idx").on(
      t.billId,
      t.dueDate,
    ),
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
    paidViaCardId: text("paid_via_card_id"),
    notes: text("notes"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userDate: index("extras_user_date_idx").on(t.userId, t.date),
  }),
);

/**
 * Credit cards have a billing cycle with TWO dates that matter:
 *   - statementDay: day of month the statement closes for calendar-day cards
 *   - statementCycleMode/AnchorDate/IntervalDays: rolling statement cycle cards
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
    statementCycleMode: text("statement_cycle_mode", {
      enum: ["calendar_day", "interval_days"],
    }).notNull().default("calendar_day"),
    statementCycleAnchorDate: text("statement_cycle_anchor_date"),
    statementCycleIntervalDays: integer("statement_cycle_interval_days").notNull().default(31),
    dueDay: integer("due_day").notNull(),
    currentBalanceCents: integer("current_balance_cents"),
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
    minimumPaymentCents: integer("minimum_payment_cents"),
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

/**
 * Per-cycle planned payments for Plaid-linked credit-card open-cycle estimates.
 * Keyed by card + dueDate because the estimate is generated from live account
 * data and projected onto the next card payment due date.
 */
export const creditCardPaymentOverrides = sqliteTable(
  "credit_card_payment_overrides",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    cardId: text("card_id")
      .notNull()
      .references(() => creditCards.id, { onDelete: "cascade" }),
    dueDate: text("due_date").notNull(),
    amountCents: integer("amount_cents").notNull(),
    notes: text("notes"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userDate: index("cc_payment_overrides_user_date_idx").on(t.userId, t.dueDate),
    cardDateUnique: uniqueIndex("cc_payment_overrides_card_date_unique_idx").on(
      t.cardId,
      t.dueDate,
    ),
  }),
);

/**
 * Promotional financing on a credit card (e.g. 0% APR for 12 months).
 * One row per promo. The card's statement balance reported by the issuer
 * INCLUDES the unbilled promo principal — we model the promo separately so
 * the projection can spread its monthly chunks over future cycles instead of
 * treating the whole purchase as a single big payment.
 *
 * Reconciliation rule (see lib/projection-server.ts):
 *   - Recorded statements with a positive due/paid amount are authoritative for
 *     the cycle they cover — a promo's chunk for that cycle is assumed to be
 *     inside the statement cash the user already entered.
 *   - For future cycles with no positive statement cash, the projection injects
 *     one debit per cycle on the cycle's due date (chunk = override or
 *     remaining/months_left). This keeps $0-due 0% APR statements from hiding
 *     a desired monthly paydown.
 *   - Plaid open-cycle estimate subtracts `remainingAmountCents` so the
 *     unbilled promo principal isn't projected as a single lump.
 */
export const creditCardPromos = sqliteTable(
  "credit_card_promos",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    cardId: text("card_id")
      .notNull()
      .references(() => creditCards.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    originalAmountCents: integer("original_amount_cents").notNull(),
    /** Decremented automatically when a statement on this card is marked paid. */
    remainingAmountCents: integer("remaining_amount_cents").notNull(),
    startDate: text("start_date").notNull(),
    /** Last day interest-free; the projection stops scheduling chunks after this. */
    endDate: text("end_date").notNull(),
    /** Optional override; when null, monthly chunk = remaining / months_left. */
    monthlyPaymentCents: integer("monthly_payment_cents"),
    notes: text("notes"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    /**
     * When set, this promo's `originalAmountCents`, `remainingAmountCents`,
     * and `endDate` are reconciled from a more-trustworthy source than the
     * Plaid transaction-history heuristic. Sync code MUST NOT overwrite
     * those fields when `authoritativeSource` is non-null.
     *
     * Values:
     *   - "paypal_promo_list": user copied data from PayPal's promo UI
     *   - "manual_reconciliation": user manually edited and locked the row
     *   - null: defaults; FIFO heuristic owns the row
     *
     * Replaces the legacy magic-string note "PayPal authoritative promo data".
     */
    authoritativeSource: text("authoritative_source", {
      enum: ["paypal_promo_list", "manual_reconciliation"],
    }),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userActive: index("cc_promos_user_active_idx").on(t.userId, t.isActive),
    cardIdx: index("cc_promos_card_idx").on(t.cardId),
  }),
);

/**
 * User-defined manual payment plan for a promo. When any rows exist for a
 * promo, the projection IGNORES the auto-spread / `monthlyPaymentCents`
 * logic and uses these payments verbatim. The schedule is purely a projection
 * input — `remainingAmountCents` on the promo is still the source of truth
 * for what's owed, and is decremented by the unpaid→paid statement edge as
 * before.
 */
export const creditCardPromoPayments = sqliteTable(
  "credit_card_promo_payments",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    promoId: text("promo_id")
      .notNull()
      .references(() => creditCardPromos.id, { onDelete: "cascade" }),
    dueDate: text("due_date").notNull(),
    amountCents: integer("amount_cents").notNull(),
    note: text("note"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    promoIdx: index("cc_promo_payments_promo_idx").on(t.promoId),
    userIdx: index("cc_promo_payments_user_idx").on(t.userId),
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
export type BillPaymentOverrideRow = typeof billPaymentOverrides.$inferSelect;
export type OneTimeExpenseRow = typeof oneTimeExpenses.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type CreditCardRow = typeof creditCards.$inferSelect;
export type CreditCardStatementRow = typeof creditCardStatements.$inferSelect;
export type CreditCardPaymentOverrideRow = typeof creditCardPaymentOverrides.$inferSelect;
export type CreditCardPromoRow = typeof creditCardPromos.$inferSelect;
export type CreditCardPromoPaymentRow = typeof creditCardPromoPayments.$inferSelect;

export type NewUser = typeof users.$inferInsert;
export type NewSettings = typeof settings.$inferInsert;
export type NewPaycheck = typeof paychecks.$inferInsert;
export type NewBill = typeof bills.$inferInsert;
export type NewBillPaymentOverride = typeof billPaymentOverrides.$inferInsert;
export type NewOneTimeExpense = typeof oneTimeExpenses.$inferInsert;
export type NewCategory = typeof categories.$inferInsert;
export type NewCreditCard = typeof creditCards.$inferInsert;
export type NewCreditCardStatement = typeof creditCardStatements.$inferInsert;
export type NewCreditCardPaymentOverride = typeof creditCardPaymentOverrides.$inferInsert;
export type NewCreditCardPromo = typeof creditCardPromos.$inferInsert;
export type NewCreditCardPromoPayment = typeof creditCardPromoPayments.$inferInsert;

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
    originalDescription: text("original_description"),
    amountCents: integer("amount_cents").notNull(),
    plaidCategory: text("plaid_category"),
    merchantName: text("merchant_name"),
    pending: integer("pending", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: ["pending_review", "approved", "dismissed"] })
      .notNull()
      .default("pending_review"),
    /**
     * Classification computed at sync time. `card_payment` is a payment toward a
     * linked credit-card balance and should not be counted as an expense — the
     * cash leaving the source account already covers it. Default `expense` keeps
     * legacy rows behaving exactly as they did before this column existed.
     */
    kind: text("kind", { enum: ["expense", "card_payment"] })
      .notNull()
      .default("expense"),
    linkedExpenseId: text("linked_expense_id"),
    linkedPromoId: text("linked_promo_id"),
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
