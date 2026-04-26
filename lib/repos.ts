import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "./db/client";
import {
  bills,
  categories,
  creditCards,
  creditCardStatements,
  oneTimeExpenses,
  paychecks,
  settings,
  users,
  type BillRow,
  type CategoryRow,
  type CreditCardRow,
  type CreditCardStatementRow,
  type NewBill,
  type NewCategory,
  type NewCreditCard,
  type NewCreditCardStatement,
  type NewOneTimeExpense,
  type NewPaycheck,
  type NewSettings,
  type OneTimeExpenseRow,
  type PaycheckRow,
  type SettingsRow,
  type UserRow,
  type UserSafe,
} from "./db/schema";
import { newId } from "./ids";
import { hashPassword } from "./auth";

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

// ── export/import ─────────────────────────────────────────────────────────────

export async function exportAll(userId: string) {
  const db = getDb();
  const [s, b, p, e, c, cc, ccs] = await Promise.all([
    getSettings(userId),
    db.select().from(bills).where(eq(bills.userId, userId)).all(),
    db.select().from(paychecks).where(eq(paychecks.userId, userId)).orderBy(desc(paychecks.payDate)).all(),
    db.select().from(oneTimeExpenses).where(eq(oneTimeExpenses.userId, userId)).all(),
    db.select().from(categories).where(eq(categories.userId, userId)).all(),
    db.select().from(creditCards).where(eq(creditCards.userId, userId)).all(),
    listStatementsForUser(userId),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: 2,
    settings: s,
    bills: b,
    paychecks: p,
    extras: e,
    categories: c,
    creditCards: cc,
    creditCardStatements: ccs,
  };
}

export async function importAll(
  userId: string,
  payload: { bills?: unknown[]; paychecks?: unknown[]; extras?: unknown[]; categories?: unknown[] },
): Promise<void> {
  const db = getDb();
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
  for (const b of (payload.bills ?? []) as Array<Partial<BillRow>>) {
    if (!b.name || !b.frequency || typeof b.amountCents !== "number" || typeof b.dueDay !== "number") continue;
    await db.insert(bills).values({
      id: b.id ?? newId(),
      userId,
      name: b.name,
      category: b.category ?? "Other",
      amountCents: b.amountCents,
      frequency: b.frequency,
      dueDay: b.dueDay,
      dueMonth: b.dueMonth ?? null,
      autoPay: b.autoPay ?? false,
      notes: b.notes ?? null,
      isActive: b.isActive ?? true,
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
      notes: e.notes ?? null,
    }).run();
  }
}
