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
  /**
   * Date the `startingBalanceCents` snapshot was taken. The projection walks
   * forward from this date — paychecks/extras/bills before it are treated as
   * already-applied to the starting balance, after it they accumulate. When
   * a Plaid account is linked as the starting balance, the projection uses
   * `today` instead of this column (live balance is always current).
   *
   * Defaults to today on first setup; users can edit it on the settings page
   * if they later realise the original snapshot was wrong.
   */
  startingBalanceAsOf: text("starting_balance_as_of").notNull().default("1970-01-01"),
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
    /**
     * ISO YYYY-MM-DD the deposit actually posted, when known — set from the
     * settling draft's date by settlePaycheckWithDraft. Payroll posts a day or
     * two off the scheduled payDate (early on holidays, late on weekends), so
     * the reconciliation ledger shows this real receipt date rather than the
     * schedule. Null for manually-marked rows (no deposit to date them by) and
     * cleared when the row is un-marked received.
     */
    actualDate: text("actual_date"),
    /**
     * Plaid transaction_id of the deposit draft that auto-reconciled this
     * paycheck as received, if any. Null on manually-reconciled rows. Once
     * set, that draft can never settle a DIFFERENT paycheck — mirror of
     * credit_card_statements.settled_by_draft_id (see settlePaycheckWithDraft
     * in lib/repos.ts). Cleared when the user un-marks received, so the
     * deposit is free to re-match.
     */
    settledByDraftId: text("settled_by_draft_id"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userDate: index("paychecks_user_date_idx").on(t.userId, t.payDate),
    // A deposit draft may settle at most ONE paycheck, globally — enforced at
    // the DB level so no code path (present or future) can double-spend it.
    settledByDraftUnique: uniqueIndex("paychecks_settled_by_draft_unique_idx")
      .on(t.settledByDraftId)
      .where(sql`settled_by_draft_id IS NOT NULL`),
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
    /**
     * User-entered bank wording that should count as this bill in the
     * transaction reconciliation (comma-separated for several), e.g. a bill
     * named "Rent" paid as "ACME PROPERTY MGMT". Same containment matching as
     * the bill name; complements the aliases learned from manual draft links.
     */
    matchAlias: text("match_alias"),
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

/**
 * What the USER asserts about one bill occurrence's payment, when the bank
 * hasn't shown us the answer yet. Deliberately separate from
 * `bill_payment_overrides`: that row says how much is PLANNED (and its
 * `amount_cents` is NOT NULL and independently deletable), this one says what
 * actually HAPPENED. A cycle can have either, both, or neither.
 *
 * `sent` — the money has left the account but no transaction has posted. The
 * occurrence keeps holding its cash and stops nagging as unpaid. This is an
 * assertion about the past, not a plan.
 * `paid_externally` — paid from somewhere this app can't see (another bank,
 * cash, someone else). Releases the cash and settles the occurrence; no
 * transaction will ever arrive to reconcile it.
 *
 * A row here is a CLAIM, never the last word: once a real posted transaction
 * matches the occurrence, reconciliation wins at read time (see
 * resolveBillOccurrenceStates) and the claim becomes inert. That makes the
 * marks self-healing — nothing has to remember to clear them.
 */
export const billPaymentStates = sqliteTable(
  "bill_payment_states",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    billId: text("bill_id")
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    dueDate: text("due_date").notNull(),
    state: text("state", { enum: ["sent", "paid_externally"] }).notNull(),
    /** What actually left the account, when the user knows it differs from
     *  the planned amount. Null = fall back to the planned amount. */
    amountCents: integer("amount_cents"),
    /** ISO date the money left the account — where a `sent` hold is placed. */
    markedDate: text("marked_date").notNull(),
    notes: text("notes"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userDate: index("bill_payment_states_user_date_idx").on(t.userId, t.dueDate),
    billDateUnique: uniqueIndex("bill_payment_states_bill_date_unique_idx").on(
      t.billId,
      t.dueDate,
    ),
  }),
);

/**
 * Expected recurring spend with a variable real-world amount, such as
 * groceries or fuel. These are forecasts, not reconciled transactions. When
 * linked to credit cards, the projection lands the expected cash movement on
 * the card statement due date instead of the purchase date.
 */
export const variableBills = sqliteTable(
  "variable_bills",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: text("category").notNull(),
    amountCents: integer("amount_cents").notNull(),
    intervalMonths: integer("interval_months").notNull(),
    anchorDate: text("anchor_date").notNull(),
    notes: text("notes"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userActive: index("variable_bills_user_active_idx").on(t.userId, t.isActive),
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
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
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
    /**
     * Minimum days between statement close and payment due, used by
     * dueDateFromStatement to pick which occurrence of dueDay a statement
     * maps to. Most US issuers grant 21-25; 14 is a safe floor default.
     */
    gracePeriodDays: integer("grace_period_days").notNull().default(14),
    currentBalanceCents: integer("current_balance_cents"),
    /**
     * Credit line, for utilization ("is this card too full?"). Seeded from the
     * linked Plaid account's reported limit while still null, then MANUAL WINS —
     * once the user sets it, sync never overwrites it (same principle as paid
     * records and due-date overrides). Null means "unknown", which the UI
     * renders as no utilization rather than as 0%.
     */
    creditLimitCents: integer("credit_limit_cents"),
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

export const variableBillCards = sqliteTable(
  "variable_bill_cards",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    variableBillId: text("variable_bill_id")
      .notNull()
      .references(() => variableBills.id, { onDelete: "cascade" }),
    cardId: text("card_id")
      .notNull()
      .references(() => creditCards.id, { onDelete: "cascade" }),
  },
  (t) => ({
    userIdx: index("variable_bill_cards_user_idx").on(t.userId),
    billIdx: index("variable_bill_cards_bill_idx").on(t.variableBillId),
    billCardUnique: uniqueIndex("variable_bill_cards_bill_card_unique_idx").on(
      t.variableBillId,
      t.cardId,
    ),
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
    /**
     * Set when the user edits dueDate by hand — Plaid liability syncs then
     * stop overwriting it (manual wins, same principle as paid records).
     */
    dueDateUserOverride: integer("due_date_user_override", { mode: "boolean" })
      .notNull()
      .default(false),
    statementBalanceCents: integer("statement_balance_cents").notNull(),
    minimumPaymentCents: integer("minimum_payment_cents"),
    paidAmountCents: integer("paid_amount_cents"),
    paidDate: text("paid_date"),
    notes: text("notes"),
    /**
     * Plaid transaction_id of the draft that auto-reconciled this statement as
     * paid, if any. Once set, that draft can never settle a DIFFERENT
     * statement — without this gate a single payment could "pay" two
     * adjacent cycles (see reconcileCardPaymentDraft in lib/plaid-sync.ts).
     */
    settledByDraftId: text("settled_by_draft_id"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    cardDue: index("cc_statements_card_due_idx").on(t.cardId, t.dueDate),
    cardDateUnique: uniqueIndex("cc_statements_card_date_unique_idx").on(t.cardId, t.statementDate),
    // A payment draft may settle at most ONE statement, globally — enforced at
    // the DB level so no code path (present or future) can double-spend a draft.
    settledByDraftUnique: uniqueIndex("cc_statements_settled_by_draft_unique_idx")
      .on(t.settledByDraftId)
      .where(sql`settled_by_draft_id IS NOT NULL`),
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
 * Deferred-interest promotional financing on a credit card.
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
 *     remaining/months_left). This keeps $0-due promotional statements from hiding
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
    /** Updated only from issuer reconciliation or an explicit manual edit. */
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
     *   - "chase_flex_plan_list": user pasted a Chase flex-plan/statement table
     *   - "manual_reconciliation": user manually edited and locked the row
     *   - null: defaults; FIFO heuristic owns the row
     *
     * Replaces the legacy magic-string note "PayPal authoritative promo data".
     */
    authoritativeSource: text("authoritative_source", {
      enum: ["paypal_promo_list", "chase_flex_plan_list", "manual_reconciliation"],
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
 * input — `remainingAmountCents` on the promo remains the issuer-reconciled
 * source of truth for what's owed.
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
  budgetAmountCents: integer("budget_amount_cents").notNull().default(0),
});

export type UserRow = typeof users.$inferSelect;
export type UserSafe = Omit<UserRow, "passwordHash">;
export type SettingsRow = typeof settings.$inferSelect;
export type PaycheckRow = typeof paychecks.$inferSelect;
export type BillRow = typeof bills.$inferSelect;
export type BillPaymentOverrideRow = typeof billPaymentOverrides.$inferSelect;
export type BillPaymentStateRow = typeof billPaymentStates.$inferSelect;
export type DraftAllocationRow = typeof draftAllocations.$inferSelect;
export type DraftAllocationTargetKind = DraftAllocationRow["targetKind"];
export type BillPaymentStateValue = BillPaymentStateRow["state"];
export type VariableBillRow = typeof variableBills.$inferSelect;
export type VariableBillCardRow = typeof variableBillCards.$inferSelect;
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
export type NewBillPaymentState = typeof billPaymentStates.$inferInsert;
export type NewDraftAllocation = typeof draftAllocations.$inferInsert;
export type NewVariableBill = typeof variableBills.$inferInsert;
export type NewVariableBillCard = typeof variableBillCards.$inferInsert;
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
    // Plaid's own item_id — how webhooks identify the item. Nullable because
    // items linked before migration 0032 are backfilled lazily (via /item/get)
    // the first time a webhook arrives for them.
    plaidItemId: text("plaid_item_id"),
  },
  (t) => ({
    userActive: index("plaid_items_user_active_idx").on(t.userId, t.isActive),
    plaidItemIdx: index("plaid_items_plaid_item_idx").on(t.plaidItemId),
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
    /**
     * Plaid `balances.available`. For a depository account this is the current
     * balance LESS pending outflows plus pending inflows, so
     * `balanceCents - availableBalanceCents` is the BANK's own measure of money
     * that has left but hasn't posted yet — the evidence the projection uses
     * instead of assuming a due bill was paid (see lib/pending-float.ts).
     * Null whenever the institution doesn't compute it.
     *
     * ALWAYS write this from the same Plaid payload as `balanceCents`: a fresh
     * current against a stale available produces a difference that is pure
     * fiction, and that fiction would hold real cash out of the projection.
     */
    availableBalanceCents: integer("available_balance_cents"),
    /** Credit line as reported by Plaid (`balances.limit`). Null for most
     *  depository accounts and for issuers that don't expose it. Seeds
     *  `credit_cards.credit_limit_cents` on link/sync while that is still null. */
    limitCents: integer("limit_cents"),
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
    /**
     * Manual bill link set by the user on /transactions. The bill
     * reconciliation treats this draft as paying that bill (bypassing the
     * name heuristic), and the draft's descriptor becomes a learned alias so
     * future months' identically-worded transactions match automatically.
     * No DB-level FK (SQLite ALTER TABLE limitation) — bills are archived,
     * not deleted, so dangling ids are effectively impossible; the matcher
     * ignores links to bills it isn't given anyway.
     */
    linkedBillId: text("linked_bill_id"),
    /**
     * User rejected this draft's heuristic bill match ("not this bill").
     * Excluded drafts never name/alias-match any bill again; an explicit
     * linkedBillId still wins (and setting one clears this flag).
     */
    billMatchExcluded: integer("bill_match_excluded", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userStatus: index("plaid_drafts_user_status_idx").on(t.userId, t.status),
    accountIdx: index("plaid_drafts_account_idx").on(t.accountId),
  }),
);

/**
 * How ONE posted transaction is divided across the obligations it paid.
 *
 * `plaid_transaction_drafts.linked_bill_id` says "this whole transaction pays
 * that bill, work out which occurrence" — right for the common case, useless
 * for a single transfer that covers two different things (the real case: a
 * $4,000 transfer paying a $2,000 recurring bill plus a $2,000 one-off, which
 * the matcher could only ever credit to one of them).
 *
 * A row here is the user stating a portion explicitly. Semantics:
 *
 * - `target_kind` is `bill` (with `target_date` = the generated occurrence
 *   date) or `extra` (a one-time expense; `target_date` is its own date).
 *   Deliberately polymorphic and FK-less on `target_id`: an obligation is
 *   just "a dated amount", and the matcher ignores targets it isn't given.
 * - **Allocations are exhaustive for their draft.** A draft with any
 *   allocation stops participating in heuristic matching entirely, so the
 *   same dollars can never be credited twice. Any unallocated remainder is
 *   simply unattributed — visible in the UI, never silently reassigned.
 * - The settle threshold still applies per target, same as manual bill links:
 *   an explicit $5 allocation does not mark a $2,000 bill paid.
 */
export const draftAllocations = sqliteTable(
  "draft_allocations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    draftId: text("draft_id")
      .notNull()
      .references(() => plaidTransactionDrafts.id, { onDelete: "cascade" }),
    targetKind: text("target_kind", { enum: ["bill", "extra"] }).notNull(),
    targetId: text("target_id").notNull(),
    /** Occurrence date for a bill; the expense's own date for an extra. */
    targetDate: text("target_date").notNull(),
    amountCents: integer("amount_cents").notNull(),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    uniqueTarget: uniqueIndex("draft_allocations_unique_target_idx").on(
      t.draftId,
      t.targetKind,
      t.targetId,
      t.targetDate,
    ),
    userDraft: index("draft_allocations_user_draft_idx").on(t.userId, t.draftId),
  }),
);

// ── Assets (net-worth tracking) ───────────────────────────────────────────────

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    valueCents: integer("value_cents").notNull(),
    category: text("category").notNull().default("other"),
    notes: text("notes"),
    asOfDate: text("as_of_date").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userIdx: index("assets_user_idx").on(t.userId),
  }),
);

// ── Web-push subscriptions ────────────────────────────────────────────────────
// One row per browser/device push subscription. `lastDigest` +
// `lastNotifiedAt` dedupe the interest-alert dispatcher: a subscription is
// only re-notified when the uncovered-dues digest changes or a day has
// passed (see lib/push.ts).

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    lastNotifiedAt: integer("last_notified_at"),
    lastDigest: text("last_digest"),
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userIdx: index("push_subscriptions_user_idx").on(t.userId),
  }),
);

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

export type PlaidItemRow = typeof plaidItems.$inferSelect;
export type PlaidAccountRow = typeof plaidAccounts.$inferSelect;
export type PlaidTransactionDraftRow = typeof plaidTransactionDrafts.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type NewAsset = typeof assets.$inferInsert;
export type NewPlaidItem = typeof plaidItems.$inferInsert;
export type NewPlaidAccount = typeof plaidAccounts.$inferInsert;
export type NewPlaidTransactionDraft = typeof plaidTransactionDrafts.$inferInsert;
