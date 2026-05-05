import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "./db/client";
import {
  bills,
  billPaymentOverrides,
  categories,
  creditCards,
  creditCardPaymentOverrides,
  creditCardPromos,
  creditCardPromoPayments,
  creditCardStatements,
  oneTimeExpenses,
  paychecks,
  plaidAccounts,
  plaidItems,
  plaidTransactionDrafts,
  settings,
  users,
  type BillRow,
  type BillPaymentOverrideRow,
  type CategoryRow,
  type CreditCardPromoRow,
  type CreditCardPromoPaymentRow,
  type CreditCardPaymentOverrideRow,
  type CreditCardRow,
  type CreditCardStatementRow,
  type NewBill,
  type NewBillPaymentOverride,
  type NewCategory,
  type NewCreditCard,
  type NewCreditCardPaymentOverride,
  type NewCreditCardPromo,
  type NewCreditCardPromoPayment,
  type NewCreditCardStatement,
  type NewOneTimeExpense,
  type NewPaycheck,
  type NewPlaidAccount,
  type NewPlaidItem,
  type NewPlaidTransactionDraft,
  type NewSettings,
  type OneTimeExpenseRow,
  type PaycheckRow,
  type PlaidAccountRow,
  type PlaidItemRow,
  type PlaidTransactionDraftRow,
  type SettingsRow,
  type UserRow,
  type UserSafe,
} from "./db/schema";
import { newId } from "./ids";
import { hashPassword } from "./auth";
import { promoMonthlyChunkAt } from "./credit-cards";

const DEFAULT_CATEGORIES: ReadonlyArray<{ name: string; color: string; kind: "expense" | "income" }> = [
  { name: "Housing", color: "#2563eb", kind: "expense" },
  { name: "Utilities", color: "#0ea5e9", kind: "expense" },
  { name: "Transportation", color: "#7c3aed", kind: "expense" },
  { name: "Food", color: "#f97316", kind: "expense" },
  { name: "Insurance", color: "#22c55e", kind: "expense" },
  { name: "Debt", color: "#ef4444", kind: "expense" },
  { name: "Subscriptions", color: "#a855f7", kind: "expense" },
  { name: "Savings", color: "#14b8a6", kind: "expense" },
  { name: "Healthcare", color: "#06b6d4", kind: "expense" },
  { name: "Gifts", color: "#ec4899", kind: "expense" },
  { name: "Entertainment", color: "#eab308", kind: "expense" },
  { name: "Other", color: "#6b7280", kind: "expense" },
  { name: "Paycheck", color: "#16a34a", kind: "income" },
];

export async function userExists(): Promise<boolean> {
  const db = getDb();
  const row = await db.select({ id: users.id }).from(users).limit(1).get();
  return Boolean(row);
}

export async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  const db = getDb();
  return db.select().from(users).where(eq(users.email, email.toLowerCase())).get();
}

// ── user management ──────────────────────────────────────────────���───────────

export async function listUsers(): Promise<UserSafe[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.createdAt))
    .all();
  return rows;
}

export async function getUserById(id: string): Promise<UserRow | undefined> {
  const db = getDb();
  return db.select().from(users).where(eq(users.id, id)).get();
}

export async function createMember(input: {
  email: string;
  displayName: string;
  password: string;
  role?: "admin" | "member";
}): Promise<UserSafe> {
  const db = getDb();
  const userId = newId();
  const passwordHash = await hashPassword(input.password);
  await db
    .insert(users)
    .values({
      id: userId,
      email: input.email.toLowerCase(),
      passwordHash,
      displayName: input.displayName,
      role: input.role ?? "member",
    })
    .run();

  // Create default settings and categories for the new user
  await db
    .insert(settings)
    .values({
      id: newId(),
      userId,
      startingBalanceCents: 0,
      defaultPaycheckCents: 0,
      firstPaydayDate: new Date().toISOString().slice(0, 10),
      payFrequencyDays: 14,
      projectionMonths: 6,
      currency: "USD",
      timezone: "America/New_York",
    })
    .run();

  for (const c of DEFAULT_CATEGORIES) {
    await db.insert(categories).values({ id: newId(), userId, ...c }).run();
  }

  return (await listUsers()).find((u) => u.id === userId)!;
}

export async function updateUserProfile(
  id: string,
  patch: { displayName?: string; role?: "admin" | "member" },
): Promise<UserSafe | undefined> {
  const db = getDb();
  const update: Partial<UserRow> = {};
  if (patch.displayName !== undefined) update.displayName = patch.displayName;
  if (patch.role !== undefined) update.role = patch.role;
  if (Object.keys(update).length === 0) return (await listUsers()).find((u) => u.id === id);
  await db.update(users).set(update).where(eq(users.id, id)).run();
  return (await listUsers()).find((u) => u.id === id);
}

export async function updateUserPassword(id: string, newPassword: string): Promise<void> {
  const db = getDb();
  const hash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash: hash }).where(eq(users.id, id)).run();
}

export async function deleteUser(id: string): Promise<void> {
  const db = getDb();
  // Cascade deletes all related rows via FK constraints
  await db.delete(users).where(eq(users.id, id)).run();
}

// ── setup ─────────────────────────────────────────────────────────────────────

export async function createOwnerAndDefaults(input: {
  email: string;
  password: string;
  displayName: string;
  startingBalanceCents: number;
  defaultPaycheckCents: number;
  firstPaydayDate: string;
  payFrequencyDays: number;
  projectionMonths: number;
  currency: string;
  timezone: string;
}): Promise<UserRow> {
  const db = getDb();
  const userId = newId();
  const passwordHash = await hashPassword(input.password);

  const newUser = {
    id: userId,
    email: input.email.toLowerCase(),
    passwordHash,
    displayName: input.displayName,
    role: "admin" as const,
  };
  await db.insert(users).values(newUser).run();

  const newSettings: NewSettings = {
    id: newId(),
    userId,
    startingBalanceCents: input.startingBalanceCents,
    defaultPaycheckCents: input.defaultPaycheckCents,
    firstPaydayDate: input.firstPaydayDate,
    payFrequencyDays: input.payFrequencyDays,
    projectionMonths: input.projectionMonths,
    currency: input.currency,
    timezone: input.timezone,
  };
  await db.insert(settings).values(newSettings).run();

  for (const c of DEFAULT_CATEGORIES) {
    const cat: NewCategory = { id: newId(), userId, ...c };
    await db.insert(categories).values(cat).run();
  }

  return (await db.select().from(users).where(eq(users.id, userId)).get())!;
}

export async function getSettings(userId: string): Promise<SettingsRow | undefined> {
  const db = getDb();
  return db.select().from(settings).where(eq(settings.userId, userId)).get();
}

export async function updateSettings(
  userId: string,
  patch: Partial<Omit<SettingsRow, "id" | "userId">>,
): Promise<SettingsRow | undefined> {
  const db = getDb();
  await db
    .update(settings)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(settings.userId, userId))
    .run();
  return getSettings(userId);
}

export async function listBills(userId: string, includeArchived = false): Promise<BillRow[]> {
  const db = getDb();
  if (includeArchived) {
    return db
      .select()
      .from(bills)
      .where(eq(bills.userId, userId))
      .orderBy(asc(bills.name))
      .all();
  }
  return db
    .select()
    .from(bills)
    .where(and(eq(bills.userId, userId), eq(bills.isActive, true)))
    .orderBy(asc(bills.name))
    .all();
}

export async function getBill(userId: string, id: string): Promise<BillRow | undefined> {
  const db = getDb();
  return db
    .select()
    .from(bills)
    .where(and(eq(bills.userId, userId), eq(bills.id, id)))
    .get();
}

export async function createBill(
  userId: string,
  data: Omit<NewBill, "id" | "userId" | "createdAt" | "updatedAt">,
): Promise<BillRow> {
  const db = getDb();
  const id = newId();
  await db.insert(bills).values({ id, userId, ...data }).run();
  return (await getBill(userId, id))!;
}

export async function updateBill(
  userId: string,
  id: string,
  patch: Partial<Omit<BillRow, "id" | "userId" | "createdAt">>,
): Promise<BillRow | undefined> {
  const db = getDb();
  await db
    .update(bills)
    .set({ ...patch, updatedAt: Date.now() })
    .where(and(eq(bills.userId, userId), eq(bills.id, id)))
    .run();
  return getBill(userId, id);
}

export async function archiveBill(userId: string, id: string): Promise<void> {
  await updateBill(userId, id, { isActive: false });
}

export async function listBillPaymentOverridesForUser(
  userId: string,
): Promise<BillPaymentOverrideRow[]> {
  const db = getDb();
  return db
    .select()
    .from(billPaymentOverrides)
    .where(eq(billPaymentOverrides.userId, userId))
    .orderBy(asc(billPaymentOverrides.dueDate))
    .all();
}

export async function upsertBillPaymentOverride(
  userId: string,
  billId: string,
  data: Omit<NewBillPaymentOverride, "id" | "userId" | "billId" | "createdAt" | "updatedAt">,
): Promise<BillPaymentOverrideRow | undefined> {
  const db = getDb();
  const bill = await getBill(userId, billId);
  if (!bill) return undefined;

  const existing = await db
    .select()
    .from(billPaymentOverrides)
    .where(
      and(
        eq(billPaymentOverrides.userId, userId),
        eq(billPaymentOverrides.billId, billId),
        eq(billPaymentOverrides.dueDate, data.dueDate),
      ),
    )
    .get();

  if (existing) {
    await db
      .update(billPaymentOverrides)
      .set({ amountCents: data.amountCents, notes: data.notes ?? null, updatedAt: Date.now() })
      .where(eq(billPaymentOverrides.id, existing.id))
      .run();
    return db
      .select()
      .from(billPaymentOverrides)
      .where(eq(billPaymentOverrides.id, existing.id))
      .get();
  }

  const id = newId();
  await db
    .insert(billPaymentOverrides)
    .values({ id, userId, billId, ...data, notes: data.notes ?? null })
    .run();
  return db
    .select()
    .from(billPaymentOverrides)
    .where(eq(billPaymentOverrides.id, id))
    .get();
}

export async function deleteBillPaymentOverride(
  userId: string,
  billId: string,
  dueDate: string,
): Promise<void> {
  const db = getDb();
  await db
    .delete(billPaymentOverrides)
    .where(
      and(
        eq(billPaymentOverrides.userId, userId),
        eq(billPaymentOverrides.billId, billId),
        eq(billPaymentOverrides.dueDate, dueDate),
      ),
    )
    .run();
}

export async function listCreditCardPaymentOverridesForUser(
  userId: string,
): Promise<CreditCardPaymentOverrideRow[]> {
  const db = getDb();
  return db
    .select()
    .from(creditCardPaymentOverrides)
    .where(eq(creditCardPaymentOverrides.userId, userId))
    .orderBy(asc(creditCardPaymentOverrides.dueDate))
    .all();
}

export async function upsertCreditCardPaymentOverride(
  userId: string,
  cardId: string,
  data: Omit<NewCreditCardPaymentOverride, "id" | "userId" | "cardId" | "createdAt" | "updatedAt">,
): Promise<CreditCardPaymentOverrideRow | undefined> {
  const db = getDb();
  const card = await getCreditCard(userId, cardId);
  if (!card) return undefined;

  const existing = await db
    .select()
    .from(creditCardPaymentOverrides)
    .where(
      and(
        eq(creditCardPaymentOverrides.userId, userId),
        eq(creditCardPaymentOverrides.cardId, cardId),
        eq(creditCardPaymentOverrides.dueDate, data.dueDate),
      ),
    )
    .get();

  if (existing) {
    await db
      .update(creditCardPaymentOverrides)
      .set({ amountCents: data.amountCents, notes: data.notes ?? null, updatedAt: Date.now() })
      .where(eq(creditCardPaymentOverrides.id, existing.id))
      .run();
    return db
      .select()
      .from(creditCardPaymentOverrides)
      .where(eq(creditCardPaymentOverrides.id, existing.id))
      .get();
  }

  const id = newId();
  await db
    .insert(creditCardPaymentOverrides)
    .values({ id, userId, cardId, ...data, notes: data.notes ?? null })
    .run();
  return db
    .select()
    .from(creditCardPaymentOverrides)
    .where(eq(creditCardPaymentOverrides.id, id))
    .get();
}

export async function deleteCreditCardPaymentOverride(
  userId: string,
  cardId: string,
  dueDate: string,
): Promise<void> {
  const db = getDb();
  await db
    .delete(creditCardPaymentOverrides)
    .where(
      and(
        eq(creditCardPaymentOverrides.userId, userId),
        eq(creditCardPaymentOverrides.cardId, cardId),
        eq(creditCardPaymentOverrides.dueDate, dueDate),
      ),
    )
    .run();
}

export async function listPaychecks(userId: string): Promise<PaycheckRow[]> {
  const db = getDb();
  return db
    .select()
    .from(paychecks)
    .where(eq(paychecks.userId, userId))
    .orderBy(asc(paychecks.payDate))
    .all();
}

export async function getPaycheck(userId: string, id: string): Promise<PaycheckRow | undefined> {
  const db = getDb();
  return db
    .select()
    .from(paychecks)
    .where(and(eq(paychecks.userId, userId), eq(paychecks.id, id)))
    .get();
}

export async function createPaycheck(
  userId: string,
  data: Omit<NewPaycheck, "id" | "userId" | "createdAt">,
): Promise<PaycheckRow> {
  const db = getDb();
  const id = newId();
  await db.insert(paychecks).values({ id, userId, ...data }).run();
  return (await getPaycheck(userId, id))!;
}

export async function updatePaycheck(
  userId: string,
  id: string,
  patch: Partial<Omit<PaycheckRow, "id" | "userId" | "createdAt">>,
): Promise<PaycheckRow | undefined> {
  const db = getDb();
  await db
    .update(paychecks)
    .set(patch)
    .where(and(eq(paychecks.userId, userId), eq(paychecks.id, id)))
    .run();
  return getPaycheck(userId, id);
}

export async function deletePaycheck(userId: string, id: string): Promise<void> {
  const db = getDb();
  await db
    .delete(paychecks)
    .where(and(eq(paychecks.userId, userId), eq(paychecks.id, id)))
    .run();
}

export async function listExtras(userId: string): Promise<OneTimeExpenseRow[]> {
  const db = getDb();
  return db
    .select()
    .from(oneTimeExpenses)
    .where(eq(oneTimeExpenses.userId, userId))
    .orderBy(asc(oneTimeExpenses.date))
    .all();
}

export async function getExtra(userId: string, id: string): Promise<OneTimeExpenseRow | undefined> {
  const db = getDb();
  return db
    .select()
    .from(oneTimeExpenses)
    .where(and(eq(oneTimeExpenses.userId, userId), eq(oneTimeExpenses.id, id)))
    .get();
}

export async function createExtra(
  userId: string,
  data: Omit<NewOneTimeExpense, "id" | "userId" | "createdAt">,
): Promise<OneTimeExpenseRow> {
  const db = getDb();
  const id = newId();
  await db.insert(oneTimeExpenses).values({ id, userId, ...data }).run();
  return (await getExtra(userId, id))!;
}

export async function updateExtra(
  userId: string,
  id: string,
  patch: Partial<Omit<OneTimeExpenseRow, "id" | "userId" | "createdAt">>,
): Promise<OneTimeExpenseRow | undefined> {
  const db = getDb();
  await db
    .update(oneTimeExpenses)
    .set(patch)
    .where(and(eq(oneTimeExpenses.userId, userId), eq(oneTimeExpenses.id, id)))
    .run();
  return getExtra(userId, id);
}

export async function deleteExtra(userId: string, id: string): Promise<void> {
  const db = getDb();
  await db
    .delete(oneTimeExpenses)
    .where(and(eq(oneTimeExpenses.userId, userId), eq(oneTimeExpenses.id, id)))
    .run();
}

export async function listCategories(userId: string): Promise<CategoryRow[]> {
  const db = getDb();
  return db
    .select()
    .from(categories)
    .where(eq(categories.userId, userId))
    .orderBy(asc(categories.kind), asc(categories.name))
    .all();
}

export async function findCategoryByName(
  userId: string,
  name: string,
): Promise<CategoryRow | undefined> {
  const db = getDb();
  return db
    .select()
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.name, name)))
    .get();
}

export async function createCategory(
  userId: string,
  input: { name: string; color: string; kind: "expense" | "income" },
): Promise<CategoryRow> {
  const db = getDb();
  const id = newId();
  await db
    .insert(categories)
    .values({ id, userId, name: input.name.trim(), color: input.color, kind: input.kind })
    .run();
  return (await db
    .select()
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.id, id)))
    .get())!;
}

export async function deleteCategory(userId: string, id: string): Promise<void> {
  const db = getDb();
  await db
    .delete(categories)
    .where(and(eq(categories.userId, userId), eq(categories.id, id)))
    .run();
}

export async function categoryUsageCount(userId: string, name: string): Promise<number> {
  const db = getDb();
  const billCount = await db
    .select({ id: bills.id })
    .from(bills)
    .where(and(eq(bills.userId, userId), eq(bills.category, name)))
    .all();
  const extraCount = await db
    .select({ id: oneTimeExpenses.id })
    .from(oneTimeExpenses)
    .where(and(eq(oneTimeExpenses.userId, userId), eq(oneTimeExpenses.category, name)))
    .all();
  return billCount.length + extraCount.length;
}

// ── credit cards ──────────────────────────────────────────────────────────────

export async function listCreditCards(
  userId: string,
  includeArchived = false,
): Promise<CreditCardRow[]> {
  const db = getDb();
  if (includeArchived) {
    return db
      .select()
      .from(creditCards)
      .where(eq(creditCards.userId, userId))
      .orderBy(asc(creditCards.name))
      .all();
  }
  return db
    .select()
    .from(creditCards)
    .where(and(eq(creditCards.userId, userId), eq(creditCards.isActive, true)))
    .orderBy(asc(creditCards.name))
    .all();
}

export async function getCreditCard(
  userId: string,
  id: string,
): Promise<CreditCardRow | undefined> {
  const db = getDb();
  return db
    .select()
    .from(creditCards)
    .where(and(eq(creditCards.userId, userId), eq(creditCards.id, id)))
    .get();
}

export async function createCreditCard(
  userId: string,
  data: Omit<NewCreditCard, "id" | "userId" | "createdAt" | "updatedAt">,
): Promise<CreditCardRow> {
  const db = getDb();
  const id = newId();
  await db.insert(creditCards).values({ id, userId, ...data }).run();
  return (await getCreditCard(userId, id))!;
}

export async function updateCreditCard(
  userId: string,
  id: string,
  patch: Partial<Omit<CreditCardRow, "id" | "userId" | "createdAt">>,
): Promise<CreditCardRow | undefined> {
  const db = getDb();
  await db
    .update(creditCards)
    .set({ ...patch, updatedAt: Date.now() })
    .where(and(eq(creditCards.userId, userId), eq(creditCards.id, id)))
    .run();
  return getCreditCard(userId, id);
}

export async function archiveCreditCard(userId: string, id: string): Promise<void> {
  await updateCreditCard(userId, id, { isActive: false });
}

export async function listStatements(cardId: string): Promise<CreditCardStatementRow[]> {
  const db = getDb();
  return db
    .select()
    .from(creditCardStatements)
    .where(eq(creditCardStatements.cardId, cardId))
    .orderBy(desc(creditCardStatements.statementDate))
    .all();
}

export async function listStatementsForUser(
  userId: string,
): Promise<Array<CreditCardStatementRow & { cardName: string }>> {
  const db = getDb();
  const cards = await listCreditCards(userId, true);
  if (cards.length === 0) return [];
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const all: Array<CreditCardStatementRow & { cardName: string }> = [];
  for (const card of cards) {
    const rows = await db
      .select()
      .from(creditCardStatements)
      .where(eq(creditCardStatements.cardId, card.id))
      .all();
    for (const r of rows) all.push({ ...r, cardName: cardById.get(r.cardId)!.name });
  }
  return all;
}

export async function getStatement(
  userId: string,
  id: string,
): Promise<CreditCardStatementRow | undefined> {
  const db = getDb();
  // Verify the statement belongs to one of the user's cards
  const row = await db
    .select()
    .from(creditCardStatements)
    .where(eq(creditCardStatements.id, id))
    .get();
  if (!row) return undefined;
  const card = await getCreditCard(userId, row.cardId);
  if (!card) return undefined;
  return row;
}

export async function createStatement(
  cardId: string,
  data: Omit<NewCreditCardStatement, "id" | "cardId" | "createdAt">,
): Promise<CreditCardStatementRow> {
  const db = getDb();
  const id = newId();
  await db.insert(creditCardStatements).values({ id, cardId, ...data }).run();
  return (await db
    .select()
    .from(creditCardStatements)
    .where(eq(creditCardStatements.id, id))
    .get())!;
}

export async function updateStatement(
  id: string,
  patch: Partial<Omit<CreditCardStatementRow, "id" | "cardId" | "createdAt">>,
): Promise<CreditCardStatementRow | undefined> {
  const db = getDb();
  await db.update(creditCardStatements).set(patch).where(eq(creditCardStatements.id, id)).run();
  return db
    .select()
    .from(creditCardStatements)
    .where(eq(creditCardStatements.id, id))
    .get();
}

export async function deleteStatement(id: string): Promise<void> {
  const db = getDb();
  await db.delete(creditCardStatements).where(eq(creditCardStatements.id, id)).run();
}

// ── credit card promos ────────────────────────────────────────────────────────

export async function listPromos(
  userId: string,
  includeArchived = false,
): Promise<CreditCardPromoRow[]> {
  const db = getDb();
  if (includeArchived) {
    return db
      .select()
      .from(creditCardPromos)
      .where(eq(creditCardPromos.userId, userId))
      .orderBy(asc(creditCardPromos.endDate))
      .all();
  }
  return db
    .select()
    .from(creditCardPromos)
    .where(and(eq(creditCardPromos.userId, userId), eq(creditCardPromos.isActive, true)))
    .orderBy(asc(creditCardPromos.endDate))
    .all();
}

export async function listPromosForCard(
  userId: string,
  cardId: string,
  includeArchived = false,
): Promise<CreditCardPromoRow[]> {
  const db = getDb();
  if (includeArchived) {
    return db
      .select()
      .from(creditCardPromos)
      .where(and(eq(creditCardPromos.userId, userId), eq(creditCardPromos.cardId, cardId)))
      .orderBy(asc(creditCardPromos.endDate))
      .all();
  }
  return db
    .select()
    .from(creditCardPromos)
    .where(
      and(
        eq(creditCardPromos.userId, userId),
        eq(creditCardPromos.cardId, cardId),
        eq(creditCardPromos.isActive, true),
      ),
    )
    .orderBy(asc(creditCardPromos.endDate))
    .all();
}

export async function getPromo(
  userId: string,
  id: string,
): Promise<CreditCardPromoRow | undefined> {
  const db = getDb();
  return db
    .select()
    .from(creditCardPromos)
    .where(and(eq(creditCardPromos.userId, userId), eq(creditCardPromos.id, id)))
    .get();
}

export async function createPromo(
  userId: string,
  cardId: string,
  data: Omit<NewCreditCardPromo, "id" | "userId" | "cardId" | "createdAt" | "updatedAt">,
): Promise<CreditCardPromoRow> {
  const db = getDb();
  const id = newId();
  await db.insert(creditCardPromos).values({ id, userId, cardId, ...data }).run();
  return (await getPromo(userId, id))!;
}

export async function updatePromo(
  userId: string,
  id: string,
  patch: Partial<Omit<CreditCardPromoRow, "id" | "userId" | "cardId" | "createdAt">>,
): Promise<CreditCardPromoRow | undefined> {
  const db = getDb();
  await db
    .update(creditCardPromos)
    .set({ ...patch, updatedAt: Date.now() })
    .where(and(eq(creditCardPromos.userId, userId), eq(creditCardPromos.id, id)))
    .run();
  return getPromo(userId, id);
}

export async function archivePromo(userId: string, id: string): Promise<void> {
  await updatePromo(userId, id, { isActive: false });
}

// ── credit card promo payment schedule ──────────────────────────────────────

export async function listPromoPayments(
  userId: string,
  promoId: string,
): Promise<CreditCardPromoPaymentRow[]> {
  const db = getDb();
  return db
    .select()
    .from(creditCardPromoPayments)
    .where(
      and(
        eq(creditCardPromoPayments.userId, userId),
        eq(creditCardPromoPayments.promoId, promoId),
      ),
    )
    .orderBy(asc(creditCardPromoPayments.dueDate))
    .all();
}

/** Read every scheduled promo payment for a user (projection batch read). */
export async function listAllPromoPayments(
  userId: string,
): Promise<CreditCardPromoPaymentRow[]> {
  const db = getDb();
  return db
    .select()
    .from(creditCardPromoPayments)
    .where(eq(creditCardPromoPayments.userId, userId))
    .orderBy(asc(creditCardPromoPayments.dueDate))
    .all();
}

/**
 * Replace the entire payment schedule for one promo. Bulk path so the UI can
 * save the full edited list with one round-trip and avoid the "delete-then-add"
 * race that per-row CRUD invites.
 */
export async function replacePromoPayments(
  userId: string,
  promoId: string,
  payments: ReadonlyArray<{ dueDate: string; amountCents: number; note?: string | null }>,
): Promise<CreditCardPromoPaymentRow[]> {
  const db = getDb();
  const newRows: NewCreditCardPromoPayment[] = payments.map((p) => ({
    id: newId(),
    userId,
    promoId,
    dueDate: p.dueDate,
    amountCents: p.amountCents,
    note: p.note ?? null,
  }));
  db.transaction((tx) => {
    tx
      .delete(creditCardPromoPayments)
      .where(
        and(
          eq(creditCardPromoPayments.userId, userId),
          eq(creditCardPromoPayments.promoId, promoId),
        ),
      )
      .run();
    for (const r of newRows) {
      tx.insert(creditCardPromoPayments).values(r).run();
    }
  });
  return listPromoPayments(userId, promoId);
}

/**
 * Decrement remaining balances on a card's active promos by the chunk amount
 * the projection assumes was inside the just-paid statement balance. Called
 * when a statement transitions from unpaid → paid (PATCH on /statements/[id]).
 *
 * The chunk per promo is `monthlyPaymentCents` if set, otherwise
 * `remaining / months_left_at_statement_close`. We clamp at zero and auto-
 * archive a promo when its remaining hits zero so it stops contributing to
 * future projections.
 *
 * Idempotency: we DON'T track which statements have been applied, so calling
 * this twice for the same statement will double-decrement. The PATCH route
 * only invokes it on the unpaid→paid transition to avoid that.
 */
export async function applyPromoChunksForPaidStatement(
  userId: string,
  cardId: string,
  statementDate: string,
): Promise<void> {
  const db = getDb();
  const promos = await listPromosForCard(userId, cardId, false);
  if (promos.length === 0) return;
  for (const promo of promos) {
    if (promo.remainingAmountCents <= 0) continue;
    // Skip promos whose window doesn't include this statement.
    if (statementDate < promo.startDate) continue;
    const chunk = promoMonthlyChunkAt(promo, statementDate);
    if (chunk <= 0) continue;
    const newRemaining = Math.max(0, promo.remainingAmountCents - chunk);
    const patch: Partial<CreditCardPromoRow> = { remainingAmountCents: newRemaining };
    if (newRemaining === 0) patch.isActive = false;
    await db
      .update(creditCardPromos)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(creditCardPromos.id, promo.id))
      .run();
  }
}

// ── plaid ──────────────────────────────────────────────────────────────────

export async function listPlaidItems(userId: string): Promise<PlaidItemRow[]> {
  const db = getDb();
  return db
    .select()
    .from(plaidItems)
    .where(and(eq(plaidItems.userId, userId), eq(plaidItems.isActive, true)))
    .orderBy(asc(plaidItems.createdAt))
    .all();
}

export async function getPlaidItem(
  userId: string,
  id: string,
): Promise<PlaidItemRow | undefined> {
  const db = getDb();
  return db
    .select()
    .from(plaidItems)
    .where(and(eq(plaidItems.userId, userId), eq(plaidItems.id, id)))
    .get();
}

export async function createPlaidItem(
  userId: string,
  data: Omit<NewPlaidItem, "id" | "userId" | "createdAt">,
): Promise<PlaidItemRow> {
  const db = getDb();
  const id = newId();
  await db.insert(plaidItems).values({ id, userId, ...data }).run();
  return (await db.select().from(plaidItems).where(eq(plaidItems.id, id)).get())!;
}

export async function updatePlaidItemCursor(
  id: string,
  cursor: string,
  lastSyncedAt: number,
): Promise<void> {
  const db = getDb();
  await db
    .update(plaidItems)
    .set({ cursor, lastSyncedAt })
    .where(eq(plaidItems.id, id))
    .run();
}

export async function deactivatePlaidItem(userId: string, id: string): Promise<void> {
  const db = getDb();
  // SQLite ALTER TABLE can't add an FK with ON DELETE SET NULL, so we
  // explicitly null `plaid_account_id` on any credit cards linked to this
  // item's accounts before deactivating. This keeps the card row intact —
  // the user just goes back to manual cycle-day management.
  const accts = await db
    .select({ id: plaidAccounts.id })
    .from(plaidAccounts)
    .where(eq(plaidAccounts.itemId, id))
    .all();
  if (accts.length > 0) {
    const ids = accts.map((a) => a.id);
    await db
      .update(creditCards)
      .set({ plaidAccountId: null, updatedAt: Date.now() })
      .where(and(eq(creditCards.userId, userId), inArray(creditCards.plaidAccountId, ids)))
      .run();
  }
  await db
    .update(plaidItems)
    .set({ isActive: false })
    .where(and(eq(plaidItems.userId, userId), eq(plaidItems.id, id)))
    .run();
}

export async function listPlaidAccounts(userId: string): Promise<PlaidAccountRow[]> {
  const db = getDb();
  return db
    .select()
    .from(plaidAccounts)
    .where(eq(plaidAccounts.userId, userId))
    .orderBy(asc(plaidAccounts.name))
    .all();
}

export async function listPlaidAccountsByItem(itemId: string): Promise<PlaidAccountRow[]> {
  const db = getDb();
  return db
    .select()
    .from(plaidAccounts)
    .where(eq(plaidAccounts.itemId, itemId))
    .all();
}

/**
 * Insert or fully replace an account row (called during each sync).
 * Uses the Plaid account_id as the primary key, so this is idempotent.
 *
 * Note: we deliberately do NOT auto-create a credit_cards row here. The user
 * explicitly maps a Plaid credit account to a manual card (existing or new)
 * via the accounts page. This prevents silent duplicates when the user already
 * has manually-tracked cards.
 */
export async function upsertPlaidAccount(data: NewPlaidAccount): Promise<void> {
  const db = getDb();
  await db
    .insert(plaidAccounts)
    .values({ ...data, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: plaidAccounts.id,
      set: {
        name: data.name,
        mask: data.mask,
        type: data.type,
        subtype: data.subtype,
        balanceCents: data.balanceCents,
        updatedAt: Date.now(),
      },
    })
    .run();
}

/**
 * Look up the user's credit card linked to a given Plaid account, if any.
 * Used by the liabilities sync to find which card to update from Plaid data.
 */
export async function getCreditCardByPlaidAccountId(
  userId: string,
  plaidAccountId: string,
): Promise<CreditCardRow | undefined> {
  const db = getDb();
  return db
    .select()
    .from(creditCards)
    .where(
      and(
        eq(creditCards.userId, userId),
        eq(creditCards.plaidAccountId, plaidAccountId),
      ),
    )
    .get();
}

/**
 * Set or clear the Plaid account link on a credit card. Pass null to unlink.
 * Enforces the unique-on-(plaid_account_id) index by checking for an existing
 * link first and returning a friendly error if conflict.
 */
export async function setCreditCardPlaidLink(
  userId: string,
  cardId: string,
  plaidAccountId: string | null,
): Promise<{ ok: true; card: CreditCardRow } | { ok: false; error: string }> {
  const db = getDb();
  const card = await getCreditCard(userId, cardId);
  if (!card) return { ok: false, error: "Card not found" };

  if (plaidAccountId !== null) {
    const owned = await db
      .select({ id: plaidAccounts.id })
      .from(plaidAccounts)
      .where(and(eq(plaidAccounts.userId, userId), eq(plaidAccounts.id, plaidAccountId)))
      .get();
    if (!owned) return { ok: false, error: "Plaid account not found" };

    const conflict = await db
      .select({ id: creditCards.id, name: creditCards.name })
      .from(creditCards)
      .where(
        and(
          eq(creditCards.userId, userId),
          eq(creditCards.plaidAccountId, plaidAccountId),
        ),
      )
      .get();
    if (conflict && conflict.id !== cardId) {
      return { ok: false, error: `Already linked to "${conflict.name}"` };
    }
  }

  await db
    .update(creditCards)
    .set({ plaidAccountId, updatedAt: Date.now() })
    .where(and(eq(creditCards.userId, userId), eq(creditCards.id, cardId)))
    .run();
  return { ok: true, card: (await getCreditCard(userId, cardId))! };
}

/**
 * Update a card's cycle days from Plaid Liabilities. No-op when both values
 * are unchanged so we don't bump updatedAt on every sync.
 */
export async function updateCardCycleDays(
  cardId: string,
  statementDay: number,
  dueDay: number,
  statementDate?: string,
): Promise<void> {
  const db = getDb();
  const current = await db
    .select({
      statementDay: creditCards.statementDay,
      dueDay: creditCards.dueDay,
      statementCycleMode: creditCards.statementCycleMode,
      statementCycleAnchorDate: creditCards.statementCycleAnchorDate,
    })
    .from(creditCards)
    .where(eq(creditCards.id, cardId))
    .get();
  if (!current) return;
  const anchorPatch =
    current.statementCycleMode === "interval_days" && statementDate
      ? { statementCycleAnchorDate: statementDate }
      : {};
  if (
    current.statementDay === statementDay &&
    current.dueDay === dueDay &&
    (anchorPatch.statementCycleAnchorDate === undefined ||
      current.statementCycleAnchorDate === anchorPatch.statementCycleAnchorDate)
  ) {
    return;
  }
  await db
    .update(creditCards)
    .set({ statementDay, dueDay, ...anchorPatch, updatedAt: Date.now() })
    .where(eq(creditCards.id, cardId))
    .run();
}

/**
 * Upsert a statement keyed by (cardId, statementDate). Uses the unique index
 * added in 0005 so re-syncs are idempotent. Will not overwrite a paid record
 * with empty paid fields — manual reconciliation wins over Plaid's read-only
 * snapshot.
 */
export async function upsertCreditCardStatementByDate(
  cardId: string,
  data: {
    statementDate: string;
    dueDate: string;
    statementBalanceCents: number;
    paidAmountCents?: number | null;
    paidDate?: string | null;
  },
): Promise<void> {
  const db = getDb();
  const existing = await db
    .select()
    .from(creditCardStatements)
    .where(
      and(
        eq(creditCardStatements.cardId, cardId),
        eq(creditCardStatements.statementDate, data.statementDate),
      ),
    )
    .get();

  if (!existing) {
    await db
      .insert(creditCardStatements)
      .values({
        id: newId(),
        cardId,
        statementDate: data.statementDate,
        dueDate: data.dueDate,
        statementBalanceCents: data.statementBalanceCents,
        paidAmountCents: data.paidAmountCents ?? null,
        paidDate: data.paidDate ?? null,
      })
      .run();
    return;
  }

  // Don't clobber a manual paid record with Plaid-only data.
  const keepPaid = existing.paidAmountCents != null && (data.paidAmountCents ?? null) == null;
  await db
    .update(creditCardStatements)
    .set({
      dueDate: data.dueDate,
      statementBalanceCents: data.statementBalanceCents,
      ...(keepPaid
        ? {}
        : { paidAmountCents: data.paidAmountCents ?? null, paidDate: data.paidDate ?? null }),
    })
    .where(eq(creditCardStatements.id, existing.id))
    .run();
}


export async function updatePlaidAccount(
  userId: string,
  accountId: string,
  patch: { useAsStartingBalance?: boolean; syncEnabled?: boolean },
): Promise<PlaidAccountRow | undefined> {
  const db = getDb();
  await db
    .update(plaidAccounts)
    .set({ ...patch, updatedAt: Date.now() })
    .where(and(eq(plaidAccounts.userId, userId), eq(plaidAccounts.id, accountId)))
    .run();
  return db
    .select()
    .from(plaidAccounts)
    .where(and(eq(plaidAccounts.userId, userId), eq(plaidAccounts.id, accountId)))
    .get();
}

export async function listPlaidDrafts(
  userId: string,
  status: "pending_review" | "approved" | "dismissed" | "all" = "pending_review",
): Promise<PlaidTransactionDraftRow[]> {
  const db = getDb();
  if (status === "all") {
    return db
      .select()
      .from(plaidTransactionDrafts)
      .where(eq(plaidTransactionDrafts.userId, userId))
      .orderBy(desc(plaidTransactionDrafts.date))
      .all();
  }
  return db
    .select()
    .from(plaidTransactionDrafts)
    .where(
      and(
        eq(plaidTransactionDrafts.userId, userId),
        eq(plaidTransactionDrafts.status, status),
      ),
    )
    .orderBy(desc(plaidTransactionDrafts.date))
    .all();
}

/**
 * Insert a transaction draft if it doesn’t already exist.
 * Uses Plaid’s transaction_id as the PK so duplicate syncs are safe.
 */
export async function upsertPlaidDraft(data: NewPlaidTransactionDraft): Promise<void> {
  const db = getDb();
  await db
    .insert(plaidTransactionDrafts)
    .values(data)
    .onConflictDoUpdate({
      target: plaidTransactionDrafts.id,
      set: {
        date: data.date,
        description: data.description,
        originalDescription: data.originalDescription,
        amountCents: data.amountCents,
        plaidCategory: data.plaidCategory,
        merchantName: data.merchantName,
        pending: data.pending,
        kind: data.kind,
      },
    })
    .run();
}

export async function getPlaidDraft(
  userId: string,
  id: string,
): Promise<PlaidTransactionDraftRow | undefined> {
  const db = getDb();
  return db
    .select()
    .from(plaidTransactionDrafts)
    .where(
      and(
        eq(plaidTransactionDrafts.userId, userId),
        eq(plaidTransactionDrafts.id, id),
      ),
    )
    .get();
}

export async function updatePlaidDraftStatus(
  userId: string,
  id: string,
  patch: {
    status: "approved" | "dismissed";
    linkedExpenseId?: string;
    linkedPromoId?: string;
  },
): Promise<PlaidTransactionDraftRow | undefined> {
  const db = getDb();
  await db
    .update(plaidTransactionDrafts)
    .set(patch)
    .where(
      and(
        eq(plaidTransactionDrafts.userId, userId),
        eq(plaidTransactionDrafts.id, id),
      ),
    )
    .run();
  return getPlaidDraft(userId, id);
}

export async function updatePlaidDraft(
  userId: string,
  id: string,
  patch: Partial<Pick<
    PlaidTransactionDraftRow,
    "date" | "description" | "amountCents" | "plaidCategory" | "merchantName" | "originalDescription"
  >>,
): Promise<PlaidTransactionDraftRow | undefined> {
  const db = getDb();
  await db
    .update(plaidTransactionDrafts)
    .set(patch)
    .where(
      and(
        eq(plaidTransactionDrafts.userId, userId),
        eq(plaidTransactionDrafts.id, id),
      ),
    )
    .run();
  return getPlaidDraft(userId, id);
}

export async function deletePlaidDraft(
  userId: string,
  id: string,
): Promise<PlaidTransactionDraftRow | undefined> {
  return updatePlaidDraftStatus(userId, id, { status: "dismissed" });
}

/**
 * Returns the balance of the first account with useAsStartingBalance=true,
 * or null if no such account exists. Used by projection-server to optionally
 * substitute a live bank balance for the manual startingBalanceCents.
 */
export async function getPrimaryLinkedBalance(userId: string): Promise<number | null> {
  const db = getDb();
  const row = await db
    .select({ balanceCents: plaidAccounts.balanceCents })
    .from(plaidAccounts)
    .where(
      and(
        eq(plaidAccounts.userId, userId),
        eq(plaidAccounts.useAsStartingBalance, true),
      ),
    )
    .get();
  return row?.balanceCents ?? null;
}

// ── export/import ─────────────────────────────────────────────────────────────

export async function exportAll(userId: string) {
  const db = getDb();
  const [s, b, bo, cpo, p, e, c, cc, ccs] = await Promise.all([
    getSettings(userId),
    db.select().from(bills).where(eq(bills.userId, userId)).all(),
    db.select().from(billPaymentOverrides).where(eq(billPaymentOverrides.userId, userId)).all(),
    db
      .select()
      .from(creditCardPaymentOverrides)
      .where(eq(creditCardPaymentOverrides.userId, userId))
      .all(),
    db.select().from(paychecks).where(eq(paychecks.userId, userId)).orderBy(desc(paychecks.payDate)).all(),
    db.select().from(oneTimeExpenses).where(eq(oneTimeExpenses.userId, userId)).all(),
    db.select().from(categories).where(eq(categories.userId, userId)).all(),
    db.select().from(creditCards).where(eq(creditCards.userId, userId)).all(),
    listStatementsForUser(userId),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: 3,
    settings: s,
    bills: b,
    billPaymentOverrides: bo,
    creditCardPaymentOverrides: cpo,
    paychecks: p,
    extras: e,
    categories: c,
    creditCards: cc,
    creditCardStatements: ccs,
  };
}

export async function importAll(
  userId: string,
  payload: {
    bills?: unknown[];
    billPaymentOverrides?: unknown[];
    creditCardPaymentOverrides?: unknown[];
    paychecks?: unknown[];
    extras?: unknown[];
    categories?: unknown[];
  },
): Promise<void> {
  const db = getDb();
  await db
    .delete(creditCardPaymentOverrides)
    .where(eq(creditCardPaymentOverrides.userId, userId))
    .run();
  await db.delete(bills).where(eq(bills.userId, userId)).run();
  await db.delete(paychecks).where(eq(paychecks.userId, userId)).run();
  await db.delete(oneTimeExpenses).where(eq(oneTimeExpenses.userId, userId)).run();
  // Categories: only replace if provided
  if (Array.isArray(payload.categories)) {
    await db.delete(categories).where(eq(categories.userId, userId)).run();
    for (const c of payload.categories as Array<Partial<CategoryRow>>) {
      if (!c.name || !c.color || !c.kind) continue;
      await db.insert(categories).values({
        id: c.id ?? newId(),
        userId,
        name: c.name,
        color: c.color,
        kind: c.kind,
      }).run();
    }
  }
  type LegacyBill = Partial<BillRow> & {
    frequency?: "monthly" | "annual";
    dueDay?: number;
    dueMonth?: number | null;
  };
  const monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (const b of (payload.bills ?? []) as LegacyBill[]) {
    if (!b.name || typeof b.amountCents !== "number") continue;
    let intervalMonths: number;
    let anchorDate: string;
    if (typeof b.intervalMonths === "number" && typeof b.anchorDate === "string") {
      intervalMonths = b.intervalMonths;
      anchorDate = b.anchorDate;
    } else if (b.frequency === "monthly" && typeof b.dueDay === "number") {
      intervalMonths = 1;
      anchorDate = `2024-01-${String(b.dueDay).padStart(2, "0")}`;
    } else if (
      b.frequency === "annual" &&
      typeof b.dueDay === "number" &&
      typeof b.dueMonth === "number"
    ) {
      intervalMonths = 12;
      const day = Math.min(b.dueDay, monthDays[b.dueMonth - 1] ?? 28);
      anchorDate = `2024-${String(b.dueMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    } else {
      continue;
    }
    await db.insert(bills).values({
      id: b.id ?? newId(),
      userId,
      name: b.name,
      category: b.category ?? "Other",
      amountCents: b.amountCents,
      intervalMonths,
      anchorDate,
      autoPay: b.autoPay ?? false,
      paidViaCardId: b.paidViaCardId ?? null,
      notes: b.notes ?? null,
      isActive: b.isActive ?? true,
    }).run();
  }
  for (const o of (payload.billPaymentOverrides ?? []) as Array<Partial<BillPaymentOverrideRow>>) {
    if (!o.billId || !o.dueDate || typeof o.amountCents !== "number") continue;
    await db.insert(billPaymentOverrides).values({
      id: o.id ?? newId(),
      userId,
      billId: o.billId,
      dueDate: o.dueDate,
      amountCents: o.amountCents,
      notes: o.notes ?? null,
    }).run();
  }
  for (const o of (payload.creditCardPaymentOverrides ?? []) as Array<
    Partial<CreditCardPaymentOverrideRow>
  >) {
    if (!o.cardId || !o.dueDate || typeof o.amountCents !== "number") continue;
    await db.insert(creditCardPaymentOverrides).values({
      id: o.id ?? newId(),
      userId,
      cardId: o.cardId,
      dueDate: o.dueDate,
      amountCents: o.amountCents,
      notes: o.notes ?? null,
    }).run();
  }
  for (const p of (payload.paychecks ?? []) as Array<Partial<PaycheckRow>>) {
    if (!p.payDate || typeof p.amountCents !== "number") continue;
    await db.insert(paychecks).values({
      id: p.id ?? newId(),
      userId,
      payDate: p.payDate,
      amountCents: p.amountCents,
      note: p.note ?? null,
      actualReceived: p.actualReceived ?? false,
      actualAmountCents: p.actualAmountCents ?? null,
    }).run();
  }
  for (const e of (payload.extras ?? []) as Array<Partial<OneTimeExpenseRow>>) {
    if (!e.date || !e.description || typeof e.amountCents !== "number") continue;
    await db.insert(oneTimeExpenses).values({
      id: e.id ?? newId(),
      userId,
      date: e.date,
      description: e.description,
      amountCents: e.amountCents,
      category: e.category ?? "Other",
      paidViaCardId: e.paidViaCardId ?? null,
      notes: e.notes ?? null,
    }).run();
  }
}
