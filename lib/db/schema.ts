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
    createdAt: integer("created_at").notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userActive: index("credit_cards_user_active_idx").on(t.userId, t.isActive),
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
