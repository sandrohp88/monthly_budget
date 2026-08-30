import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { getDb } from "./db/client";
import {
  interestSavingCashDueCents,
  openStatementObligation,
  statementCashDueCents,
  type OpenStatementObligation,
} from "./credit-cards";
import {
  assets,
  bills,
  billPaymentOverrides,
  billPaymentStates,
  draftAllocations,
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
  pushSubscriptions,
  settings,
  users,
  variableBillCards,
  variableBills,
  type AssetRow,
  type BillRow,
  type BillPaymentOverrideRow,
  type BillPaymentStateRow,
  type DraftAllocationRow,
  type DraftAllocationTargetKind,
  type CategoryRow,
  type CreditCardPromoRow,
  type CreditCardPromoPaymentRow,
  type CreditCardPaymentOverrideRow,
  type CreditCardRow,
  type CreditCardStatementRow,
  type NewBill,
  type NewBillPaymentOverride,
  type NewBillPaymentState,
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
  type PushSubscriptionRow,
  type NewVariableBill,
  type NewVariableBillCard,
  type OneTimeExpenseRow,
  type PaycheckRow,
  type PlaidAccountRow,
  type PlaidItemRow,
  type PlaidTransactionDraftRow,
  type SettingsRow,
  type UserRow,
  type UserSafe,
  type VariableBillRow,
} from "./db/schema";
import { newId } from "./ids";
import { hashPassword } from "./auth";
import { calculateMonthlyHistoryAverage } from "./variable-bills";
import { log } from "./log";

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
      startingBalanceAsOf: new Date().toISOString().slice(0, 10),
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

/**
 * Sentinel thrown by `createOwnerAndDefaults` when another request beat us to
 * the empty-DB check. The route handler maps this to a 409 with a generic
 * message; never surface the inner reason to the caller. The setup endpoint
 * must be racing-safe even though the legitimate flow only ever runs once.
 */
export class OwnerAlreadyExistsError extends Error {
  constructor() {
    super("owner already exists");
    this.name = "OwnerAlreadyExistsError";
  }
}

export async function createOwnerAndDefaults(input: {
  email: string;
  password: string;
  displayName: string;
  startingBalanceCents: number;
  startingBalanceAsOf: string;
  defaultPaycheckCents: number;
  firstPaydayDate: string;
  payFrequencyDays: number;
  projectionMonths: number;
  currency: string;
  timezone: string;
}): Promise<UserRow> {
  const db = getDb();
  const userId = newId();
  // Hash before opening the transaction so we don't hold a write lock for the
  // ~100ms argon2 cost. The user row is inserted atomically below — if a
  // concurrent setup wins the race, the existence check inside the
  // transaction throws and the discarded hash never reaches disk.
  const passwordHash = await hashPassword(input.password);

  db.transaction((tx) => {
    // Re-check inside the transaction so two simultaneous /api/setup calls
    // can't both pass the pre-flight `userExists()` and create two admins.
    // The unique email index would still catch matching emails, but two
    // setup calls from different browsers (different emails) would both
    // succeed without this guard.
    const existing = tx.select({ id: users.id }).from(users).limit(1).get();
    if (existing) throw new OwnerAlreadyExistsError();

    tx.insert(users).values({
      id: userId,
      email: input.email.toLowerCase(),
      passwordHash,
      displayName: input.displayName,
      role: "admin" as const,
    }).run();

    const newSettings: NewSettings = {
      id: newId(),
      userId,
      startingBalanceCents: input.startingBalanceCents,
      startingBalanceAsOf: input.startingBalanceAsOf,
      defaultPaycheckCents: input.defaultPaycheckCents,
      firstPaydayDate: input.firstPaydayDate,
      payFrequencyDays: input.payFrequencyDays,
      projectionMonths: input.projectionMonths,
      currency: input.currency,
      timezone: input.timezone,
    };
    tx.insert(settings).values(newSettings).run();

    for (const c of DEFAULT_CATEGORIES) {
      const cat: NewCategory = { id: newId(), userId, ...c };
      tx.insert(categories).values(cat).run();
    }
  });

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

export type VariableBillWithCards = VariableBillRow & { cardIds: string[] };

async function cardIdsForVariableBills(
  userId: string,
  billIds: ReadonlyArray<string>,
): Promise<Map<string, string[]>> {
  const db = getDb();
  if (billIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(variableBillCards)
    .where(
      and(
        eq(variableBillCards.userId, userId),
        inArray(variableBillCards.variableBillId, [...billIds]),
      ),
    )
    .all();
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const list = out.get(row.variableBillId) ?? [];
    list.push(row.cardId);
    out.set(row.variableBillId, list);
  }
  return out;
}

export async function listVariableBills(
  userId: string,
  includeArchived = false,
): Promise<VariableBillWithCards[]> {
  const db = getDb();
  const rows = includeArchived
    ? await db
        .select()
        .from(variableBills)
        .where(eq(variableBills.userId, userId))
        .orderBy(asc(variableBills.name))
        .all()
    : await db
        .select()
        .from(variableBills)
        .where(and(eq(variableBills.userId, userId), eq(variableBills.isActive, true)))
        .orderBy(asc(variableBills.name))
        .all();
  const cardsByBill = await cardIdsForVariableBills(userId, rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, cardIds: cardsByBill.get(row.id) ?? [] }));
}

export async function getVariableBill(
  userId: string,
  id: string,
): Promise<VariableBillWithCards | undefined> {
  const rows = await listVariableBills(userId, true);
  return rows.find((row) => row.id === id);
}

async function replaceVariableBillCards(
  userId: string,
  variableBillId: string,
  cardIds: ReadonlyArray<string>,
): Promise<void> {
  const db = getDb();
  const cards = await listCreditCards(userId, true);
  const ownedIds = new Set(cards.map((card) => card.id));
  const uniqueIds = Array.from(new Set(cardIds));
  if (uniqueIds.length === 0) throw new Error("At least one card is required");
  for (const cardId of uniqueIds) {
    if (!ownedIds.has(cardId)) throw new Error("Card not found");
  }

  await db
    .delete(variableBillCards)
    .where(
      and(
        eq(variableBillCards.userId, userId),
        eq(variableBillCards.variableBillId, variableBillId),
      ),
    )
    .run();

  for (const cardId of uniqueIds) {
    const row: NewVariableBillCard = {
      id: newId(),
      userId,
      variableBillId,
      cardId,
    };
    await db.insert(variableBillCards).values(row).run();
  }
}

export async function createVariableBill(
  userId: string,
  data: Omit<NewVariableBill, "id" | "userId" | "createdAt" | "updatedAt"> & {
    cardIds: string[];
  },
): Promise<VariableBillWithCards> {
  const db = getDb();
  const id = newId();
  const { cardIds, ...bill } = data;
  await db.insert(variableBills).values({ id, userId, ...bill }).run();
  await replaceVariableBillCards(userId, id, cardIds);
  return (await getVariableBill(userId, id))!;
}

export async function updateVariableBill(
  userId: string,
  id: string,
  patch: Partial<Omit<VariableBillRow, "id" | "userId" | "createdAt">> & {
    cardIds?: string[];
  },
): Promise<VariableBillWithCards | undefined> {
  const db = getDb();
  const existing = await getVariableBill(userId, id);
  if (!existing) return undefined;
  const { cardIds, ...billPatch } = patch;
  if (Object.keys(billPatch).length > 0) {
    await db
      .update(variableBills)
      .set({ ...billPatch, updatedAt: Date.now() })
      .where(and(eq(variableBills.userId, userId), eq(variableBills.id, id)))
      .run();
  }
  if (cardIds) await replaceVariableBillCards(userId, id, cardIds);
  return getVariableBill(userId, id);
}

export async function archiveVariableBill(userId: string, id: string): Promise<void> {
  await updateVariableBill(userId, id, { isActive: false });
}

export async function estimateVariableBillAverage(
  userId: string,
  opts: {
    name?: string;
    category?: string;
    cardIds?: string[];
    lookbackMonths: number;
    asOfIso: string;
  },
): Promise<{
  averageCents: number;
  totalCents: number;
  sampleCount: number;
  monthlyTotals: Array<{ month: string; amountCents: number }>;
}> {
  const db = getDb();
  const cardIds = opts.cardIds ?? [];
  const selectedCards = cardIds.length > 0
    ? (await listCreditCards(userId, true)).filter((card) => cardIds.includes(card.id))
    : await listCreditCards(userId, true);
  const accountIds = selectedCards
    .map((card) => card.plaidAccountId)
    .filter((id): id is string => !!id);
  if (cardIds.length > 0 && accountIds.length === 0) {
    return calculateMonthlyHistoryAverage([], opts.asOfIso, opts.lookbackMonths);
  }

  const [year, month] = opts.asOfIso.split("-").map(Number);
  const cutoffMonth = new Date(Date.UTC(year!, month! - opts.lookbackMonths, 1));
  const cutoff = cutoffMonth.toISOString().slice(0, 10);
  const conditions = [
    eq(plaidTransactionDrafts.userId, userId),
    eq(plaidTransactionDrafts.status, "approved" as const),
    eq(plaidTransactionDrafts.kind, "expense" as const),
    gte(plaidTransactionDrafts.date, cutoff),
  ];
  if (accountIds.length > 0) {
    conditions.push(inArray(plaidTransactionDrafts.accountId, accountIds));
  }

  const rows = await db
    .select({
      date: plaidTransactionDrafts.date,
      amountCents: plaidTransactionDrafts.amountCents,
      description: plaidTransactionDrafts.description,
      originalDescription: plaidTransactionDrafts.originalDescription,
      merchantName: plaidTransactionDrafts.merchantName,
      plaidCategory: plaidTransactionDrafts.plaidCategory,
    })
    .from(plaidTransactionDrafts)
    .where(and(...conditions))
    .all();

  const terms = Array.from(
    new Set(
      [opts.name, opts.category]
        .flatMap((value) => value?.toLowerCase().split(/[^a-z0-9]+/) ?? [])
        .map((term) => term.trim())
        .filter((term) => term.length >= 3),
    ),
  );
  const matchingRows = rows.filter((row) => {
    if (row.amountCents <= 0) return false;
    if (terms.length === 0) return true;
    const haystack = [
      row.description,
      row.originalDescription,
      row.merchantName,
      row.plaidCategory,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });

  return calculateMonthlyHistoryAverage(matchingRows, opts.asOfIso, opts.lookbackMonths);
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

// ── bill payment states (what the user asserts happened) ─────────────────────

export async function listBillPaymentStatesForUser(
  userId: string,
): Promise<BillPaymentStateRow[]> {
  const db = getDb();
  return db
    .select()
    .from(billPaymentStates)
    .where(eq(billPaymentStates.userId, userId))
    .orderBy(asc(billPaymentStates.dueDate))
    .all();
}

/**
 * Record (or replace) the user's assertion about one occurrence. One row per
 * `(bill, dueDate)` — re-marking an occurrence overwrites the previous claim
 * rather than stacking, so "sent" → "paid externally" is just a re-save.
 */
export async function upsertBillPaymentState(
  userId: string,
  billId: string,
  data: Omit<NewBillPaymentState, "id" | "userId" | "billId" | "createdAt" | "updatedAt">,
): Promise<BillPaymentStateRow | undefined> {
  const db = getDb();
  const bill = await getBill(userId, billId);
  if (!bill) return undefined;

  const existing = await db
    .select()
    .from(billPaymentStates)
    .where(
      and(
        eq(billPaymentStates.userId, userId),
        eq(billPaymentStates.billId, billId),
        eq(billPaymentStates.dueDate, data.dueDate),
      ),
    )
    .get();

  if (existing) {
    await db
      .update(billPaymentStates)
      .set({
        state: data.state,
        amountCents: data.amountCents ?? null,
        markedDate: data.markedDate,
        notes: data.notes ?? null,
        updatedAt: Date.now(),
      })
      .where(eq(billPaymentStates.id, existing.id))
      .run();
    return db.select().from(billPaymentStates).where(eq(billPaymentStates.id, existing.id)).get();
  }

  const id = newId();
  await db
    .insert(billPaymentStates)
    .values({
      id,
      userId,
      billId,
      ...data,
      amountCents: data.amountCents ?? null,
      notes: data.notes ?? null,
    })
    .run();
  return db.select().from(billPaymentStates).where(eq(billPaymentStates.id, id)).get();
}

export async function deleteBillPaymentState(
  userId: string,
  billId: string,
  dueDate: string,
): Promise<void> {
  const db = getDb();
  await db
    .delete(billPaymentStates)
    .where(
      and(
        eq(billPaymentStates.userId, userId),
        eq(billPaymentStates.billId, billId),
        eq(billPaymentStates.dueDate, dueDate),
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

export async function listPaychecks(userId: string, includeArchived = false): Promise<PaycheckRow[]> {
  const db = getDb();
  const conditions = [eq(paychecks.userId, userId)];
  if (!includeArchived) conditions.push(eq(paychecks.isActive, true));
  return db
    .select()
    .from(paychecks)
    .where(and(...conditions))
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
  // Archiving releases the deposit draft that auto-reconciled this row (if
  // any) — an archived paycheck is out of the projection, so keeping the
  // draft consumed would only stop that deposit from settling the paycheck
  // the user actually meant (e.g. after deleting a duplicate row).
  await db
    .update(paychecks)
    .set({ isActive: false, settledByDraftId: null })
    .where(and(eq(paychecks.userId, userId), eq(paychecks.id, id)))
    .run();
}

/**
 * Paychecks awaiting reconciliation — active, not yet received — with payDate
 * in [startIso, endIso]. Feed for the deposit matcher in lib/plaid-sync.ts.
 */
export async function listUnreconciledPaychecksInRange(
  userId: string,
  startIso: string,
  endIso: string,
): Promise<PaycheckRow[]> {
  const db = getDb();
  return db
    .select()
    .from(paychecks)
    .where(
      and(
        eq(paychecks.userId, userId),
        eq(paychecks.isActive, true),
        eq(paychecks.actualReceived, false),
        gte(paychecks.payDate, startIso),
        lte(paychecks.payDate, endIso),
      ),
    )
    .orderBy(asc(paychecks.payDate))
    .all();
}

/**
 * Draft ids already consumed by SOME paycheck (any status, archived included
 * until the archive path releases them). The matcher must never see these —
 * a spent draft winning an assignment would starve a free one.
 */
export async function listConsumedPaycheckDraftIds(userId: string): Promise<Set<string>> {
  const db = getDb();
  const rows = await db
    .select({ draftId: paychecks.settledByDraftId })
    .from(paychecks)
    .where(and(eq(paychecks.userId, userId), isNotNull(paychecks.settledByDraftId)))
    .all();
  return new Set(rows.map((r) => r.draftId).filter((d): d is string => d != null));
}

/**
 * Consume a deposit draft against a scheduled paycheck — the ONLY path that
 * may mark a paycheck received from a Plaid draft. Mirrors
 * settleStatementWithDraft's contract:
 *
 * 1. Draft already consumed by any paycheck (globally) → no-op. Backed by the
 *    partial UNIQUE index from migration 0029, so a double-spend is a
 *    constraint violation even if a future code path skips this check.
 * 2. Fires ONLY on the not-received → received edge: a paycheck that is
 *    already received (manually or by a previous sync) is never touched —
 *    manual reconciliation always wins, and re-syncs are no-ops.
 *
 * Returns the updated row, or null when nothing was settled.
 */
export async function settlePaycheckWithDraft(
  userId: string,
  input: { paycheckId: string; draftId: string; amountCents: number; date: string },
): Promise<PaycheckRow | null> {
  if (input.amountCents <= 0) return null;

  const consumed = await listConsumedPaycheckDraftIds(userId);
  if (consumed.has(input.draftId)) return null;

  const existing = await getPaycheck(userId, input.paycheckId);
  if (!existing || !existing.isActive) return null;
  // The not-received → received edge — never overwrite a reconciled row.
  if (existing.actualReceived || existing.settledByDraftId != null) return null;

  const db = getDb();
  await db
    .update(paychecks)
    .set({
      actualReceived: true,
      actualAmountCents: input.amountCents,
      actualDate: input.date,
      settledByDraftId: input.draftId,
    })
    .where(and(eq(paychecks.userId, userId), eq(paychecks.id, input.paycheckId)))
    .run();
  return (await getPaycheck(userId, input.paycheckId)) ?? null;
}

export async function listExtras(userId: string, includeArchived = false): Promise<OneTimeExpenseRow[]> {
  const db = getDb();
  const conditions = [eq(oneTimeExpenses.userId, userId)];
  if (!includeArchived) conditions.push(eq(oneTimeExpenses.isActive, true));
  return db
    .select()
    .from(oneTimeExpenses)
    .where(and(...conditions))
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
    .update(oneTimeExpenses)
    .set({ isActive: false })
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
  input: { name: string; color: string; kind: "expense" | "income"; budgetAmountCents?: number },
): Promise<CategoryRow> {
  const db = getDb();
  const id = newId();
  await db
    .insert(categories)
    .values({
      id,
      userId,
      name: input.name.trim(),
      color: input.color,
      kind: input.kind,
      budgetAmountCents: input.budgetAmountCents ?? 0,
    })
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

export async function updateCategory(
  userId: string,
  id: string,
  data: { name?: string; color?: string; kind?: "expense" | "income"; budgetAmountCents?: number },
): Promise<CategoryRow | undefined> {
  const db = getDb();
  const set: Record<string, unknown> = {};
  if (data.name !== undefined) set.name = data.name;
  if (data.color !== undefined) set.color = data.color;
  if (data.kind !== undefined) set.kind = data.kind;
  if (data.budgetAmountCents !== undefined) set.budgetAmountCents = data.budgetAmountCents;
  if (Object.keys(set).length === 0) return undefined;
  await db
    .update(categories)
    .set(set)
    .where(and(eq(categories.userId, userId), eq(categories.id, id)))
    .run();
  return db
    .select()
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.id, id)))
    .get();
}

export type CategoryUtilization = {
  category: string;
  color: string;
  budgetCents: number;
  spentCents: number;
};

export async function computeCategoryUtilization(
  userId: string,
  month: string,
): Promise<CategoryUtilization[]> {
  const db = getDb();
  const cats = await db
    .select()
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.kind, "expense")))
    .all();

  const budgetedCats = cats.filter((c) => c.budgetAmountCents > 0);
  if (budgetedCats.length === 0) return [];

  const monthStart = `${month}-01`;
  const parts = month.split("-").map(Number);
  const y = parts[0]!;
  const m = parts[1]!;
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const monthEnd = `${nextMonth}-01`;

  const userBills = await db
    .select()
    .from(bills)
    .where(and(eq(bills.userId, userId), eq(bills.isActive, true)))
    .all();

  const extras = await db
    .select()
    .from(oneTimeExpenses)
    .where(
      and(
        eq(oneTimeExpenses.userId, userId),
        gte(oneTimeExpenses.date, monthStart),
        lt(oneTimeExpenses.date, monthEnd),
      ),
    )
    .all();

  const drafts = await db
    .select()
    .from(plaidTransactionDrafts)
    .where(
      and(
        eq(plaidTransactionDrafts.userId, userId),
        eq(plaidTransactionDrafts.status, "approved"),
        eq(plaidTransactionDrafts.kind, "expense"),
        gte(plaidTransactionDrafts.date, monthStart),
        lt(plaidTransactionDrafts.date, monthEnd),
      ),
    )
    .all();

  const spendByCategory = new Map<string, number>();

  for (const b of userBills) {
    if (b.intervalMonths === 1) {
      spendByCategory.set(b.category, (spendByCategory.get(b.category) ?? 0) + b.amountCents);
    } else {
      const monthly = Math.round(b.amountCents / b.intervalMonths);
      spendByCategory.set(b.category, (spendByCategory.get(b.category) ?? 0) + monthly);
    }
  }

  for (const e of extras) {
    spendByCategory.set(e.category, (spendByCategory.get(e.category) ?? 0) + e.amountCents);
  }

  for (const d of drafts) {
    const matched = budgetedCats.find(
      (c) => c.name.toLowerCase() === (d.plaidCategory ?? "").toLowerCase(),
    );
    if (matched) {
      spendByCategory.set(matched.name, (spendByCategory.get(matched.name) ?? 0) + d.amountCents);
    }
  }

  return budgetedCats.map((c) => ({
    category: c.name,
    color: c.color,
    budgetCents: c.budgetAmountCents,
    spentCents: spendByCategory.get(c.name) ?? 0,
  }));
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

// ── assets ───────────────────────────────────────────────────────────────────

export async function listAssets(userId: string, includeArchived = false): Promise<AssetRow[]> {
  const db = getDb();
  const conditions = [eq(assets.userId, userId)];
  if (!includeArchived) conditions.push(eq(assets.isActive, true));
  return db
    .select()
    .from(assets)
    .where(and(...conditions))
    .orderBy(desc(assets.valueCents))
    .all();
}

export async function getAsset(userId: string, id: string): Promise<AssetRow | undefined> {
  const db = getDb();
  return db
    .select()
    .from(assets)
    .where(and(eq(assets.userId, userId), eq(assets.id, id)))
    .get();
}

export async function createAsset(
  userId: string,
  data: {
    name: string;
    valueCents: number;
    category?: string;
    notes?: string | null;
    asOfDate: string;
  },
): Promise<AssetRow> {
  const db = getDb();
  const id = newId();
  await db
    .insert(assets)
    .values({
      id,
      userId,
      name: data.name,
      valueCents: data.valueCents,
      category: data.category ?? "other",
      notes: data.notes ?? null,
      asOfDate: data.asOfDate,
    })
    .run();
  return db
    .select()
    .from(assets)
    .where(eq(assets.id, id))
    .get() as AssetRow;
}

export async function updateAsset(
  userId: string,
  id: string,
  data: {
    name?: string;
    valueCents?: number;
    category?: string;
    notes?: string | null;
    asOfDate?: string;
    isActive?: boolean;
  },
): Promise<AssetRow | undefined> {
  const db = getDb();
  const existing = await getAsset(userId, id);
  if (!existing) return undefined;
  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  if (data.name !== undefined) patch.name = data.name;
  if (data.valueCents !== undefined) patch.valueCents = data.valueCents;
  if (data.category !== undefined) patch.category = data.category;
  if (data.notes !== undefined) patch.notes = data.notes;
  if (data.asOfDate !== undefined) patch.asOfDate = data.asOfDate;
  if (data.isActive !== undefined) patch.isActive = data.isActive;
  await db
    .update(assets)
    .set(patch)
    .where(and(eq(assets.userId, userId), eq(assets.id, id)))
    .run();
  return getAsset(userId, id);
}

export async function archiveAsset(userId: string, id: string): Promise<void> {
  const db = getDb();
  await db
    .update(assets)
    .set({ isActive: false, updatedAt: Date.now() })
    .where(and(eq(assets.userId, userId), eq(assets.id, id)))
    .run();
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

/**
 * What this card still owes across its recorded statements — the number the
 * archive confirmation quotes.
 *
 * Archiving is not blocked by it. The projection raises due markers for ACTIVE
 * cards only, so archiving a card mid-obligation takes that debt out of view;
 * the API makes the caller acknowledge the amount first (see the DELETE route)
 * instead of letting it vanish silently, which is how a $48.19 Capital One
 * balance ended up stranded on an archived duplicate in the first place.
 */
export async function getCardOpenObligation(
  userId: string,
  cardId: string,
): Promise<OpenStatementObligation> {
  const [statements, promos] = await Promise.all([
    listStatements(cardId),
    listPromosForCard(userId, cardId),
  ]);
  return openStatementObligation(statements, promos);
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

/**
 * Absolute-cents tolerance for auto-matching a payment to a statement. A real
 * "pay the statement balance" autopay reports the exact balance; this only
 * absorbs sub-dollar noise (Plaid's float dollar amounts, issuer rounding) —
 * deliberately NOT a percentage, so a partial payment (even 90%+ of the
 * balance, e.g. $460 against a $505.10 statement) never gets treated as
 * clearing the statement. A true partial is left unmatched: there's no data
 * model for "partially paid, $X still owed" (isStatementOpen in
 * lib/credit-cards.ts treats ANY recorded paidAmountCents as resolved,
 * regardless of amount), so recording a partial would misrepresent the
 * statement as settled rather than actually track the residual.
 */
const STATEMENT_MATCH_TOLERANCE_CENTS = 100;

/**
 * Has `draftId` already settled (or been consumed by) a statement anywhere in
 * this user's account? A payment draft may settle at most one statement, EVER
 * — globally, not per card, so re-linking a Plaid account to a different card
 * can't free an already-spent draft. Backed by the partial UNIQUE index from
 * migration 0025, which makes a double-spend a constraint violation even if a
 * future code path skips this check.
 */
export async function getStatementSettledByDraft(
  userId: string,
  draftId: string,
): Promise<CreditCardStatementRow | undefined> {
  const db = getDb();
  const row = await db
    .select({ statement: creditCardStatements })
    .from(creditCardStatements)
    .innerJoin(creditCards, eq(creditCardStatements.cardId, creditCards.id))
    .where(
      and(
        eq(creditCards.userId, userId),
        eq(creditCardStatements.settledByDraftId, draftId),
      ),
    )
    .get();
  return row?.statement;
}

/**
 * Consume a payment draft against the card's statements — the ONLY path that
 * may mark a statement paid from a Plaid draft. One atomic decision per call:
 *
 * 1. Draft already consumed (globally) → no-op.
 * 2. A PAID statement of unknown provenance (no settledByDraftId — marked paid
 *    manually, by the Liabilities sync, restored from a pre-0024 backup)
 *    matches this payment's window and amount → assume this draft IS that
 *    payment: stamp it for provenance and consume the draft WITHOUT settling
 *    anything new. This is what stops a payment whose statement was paid by
 *    another path from "settling" the next cycle.
 * 3. An UNPAID statement's cash due — the full `statementCashDueCents` (the
 *    minimum for PayPal $0-balance statements, the balance otherwise) OR the
 *    card's `interestSavingCashDueCents` when active promos exist — matches
 *    within `STATEMENT_MATCH_TOLERANCE_CENTS` and the due date is within
 *    `dateRangeDays` of the payment date → mark it paid and stamp the draft.
 *    (Promo balances are never mutated here — issuer reconciliation is the
 *    only trustworthy source, §17a.)
 *
 * Returns the newly-settled statement, or null when nothing was settled
 * (consumed, accounted, or no match).
 */
export async function settleStatementWithDraft(
  userId: string,
  input: {
    draftId: string;
    cardId: string;
    paymentCents: number;
    date: string;
    dateRangeDays?: number;
  },
): Promise<(CreditCardStatementRow & { cardId: string }) | null> {
  const dateRangeDays = input.dateRangeDays ?? 35;
  if (input.paymentCents <= 0) return null;

  const consumed = await getStatementSettledByDraft(userId, input.draftId);
  if (consumed) return null;

  const db = getDb();
  const stmts = await db
    .select()
    .from(creditCardStatements)
    .where(eq(creditCardStatements.cardId, input.cardId))
    .orderBy(desc(creditCardStatements.statementDate))
    .all();

  // A payment for the Interest Saving Balance (full balance minus 0%-promo
  // principal plus this cycle's plan payments) settles a statement the same as
  // a full-balance payment — it's the amount that actually avoids interest on
  // a card with active flexible-financing promos.
  const activePromos = await db
    .select()
    .from(creditCardPromos)
    .where(
      and(
        eq(creditCardPromos.userId, userId),
        eq(creditCardPromos.cardId, input.cardId),
        eq(creditCardPromos.isActive, true),
      ),
    )
    .all();

  const targetTime = new Date(input.date).getTime();
  const withinWindow = (s: CreditCardStatementRow) =>
    Math.abs(new Date(s.dueDate).getTime() - targetTime) / (1000 * 60 * 60 * 24) <=
    dateRangeDays;
  const amountMatches = (cents: number) =>
    Math.abs(cents - input.paymentCents) <= STATEMENT_MATCH_TOLERANCE_CENTS;
  const matchesDue = (s: CreditCardStatementRow) =>
    amountMatches(statementCashDueCents(s)) ||
    amountMatches(interestSavingCashDueCents(s, activePromos));

  // Step 2 — already-accounted heuristic (statements are newest-first, so the
  // most recent plausible cycle wins).
  const accounted = stmts.find(
    (s) =>
      s.paidAmountCents != null &&
      s.settledByDraftId == null &&
      withinWindow(s) &&
      (amountMatches(s.paidAmountCents) || matchesDue(s)),
  );
  if (accounted) {
    await db
      .update(creditCardStatements)
      .set({ settledByDraftId: input.draftId })
      .where(eq(creditCardStatements.id, accounted.id))
      .run();
    return null;
  }

  // Step 3 — settle an open statement by its cash due (full balance or ISB).
  const match = stmts.find((s) => {
    if (s.paidAmountCents != null) return false;
    if (statementCashDueCents(s) <= 0) return false;
    return withinWindow(s) && matchesDue(s);
  });
  if (!match) return null;

  await db
    .update(creditCardStatements)
    .set({
      paidAmountCents: input.paymentCents,
      paidDate: input.date,
      settledByDraftId: input.draftId,
    })
    .where(eq(creditCardStatements.id, match.id))
    .run();
  return {
    ...match,
    cardId: input.cardId,
    paidAmountCents: input.paymentCents,
    paidDate: input.date,
    settledByDraftId: input.draftId,
  };
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
  // Zero remaining on archive. An inactive promo is already excluded from the
  // projection (which filters `isActive && remaining > 0`), so a lingering
  // `remainingAmountCents` changes no projection behavior — it only pollutes
  // promo totals and the card UI (the "phantom remaining" bug). Clearing it
  // keeps stored state honest.
  await updatePromo(userId, id, { isActive: false, remainingAmountCents: 0 });
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

/**
 * Webhook-path lookup: Plaid identifies items by its own `item_id` and no
 * user session exists on that request, so this is deliberately cross-user.
 */
export async function getPlaidItemByPlaidItemId(
  plaidItemId: string,
): Promise<PlaidItemRow | undefined> {
  const db = getDb();
  return db
    .select()
    .from(plaidItems)
    .where(and(eq(plaidItems.plaidItemId, plaidItemId), eq(plaidItems.isActive, true)))
    .get();
}

/**
 * Items linked before migration 0032 have no stored `plaid_item_id`; the
 * webhook handler backfills them lazily via Plaid `/item/get`. Cross-user for
 * the same reason as above.
 */
export async function listActivePlaidItemsMissingPlaidItemId(): Promise<PlaidItemRow[]> {
  const db = getDb();
  return db
    .select()
    .from(plaidItems)
    .where(and(isNull(plaidItems.plaidItemId), eq(plaidItems.isActive, true)))
    .all();
}

export async function setPlaidItemPlaidItemId(id: string, plaidItemId: string): Promise<void> {
  const db = getDb();
  await db.update(plaidItems).set({ plaidItemId }).where(eq(plaidItems.id, id)).run();
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

/**
 * Stamp the live-balance throttle for an item (migration 0038). Called on
 * every completed `/accounts/balance/get` ATTEMPT — success or failure — so a
 * persistently erroring institution backs off instead of being retried on
 * every sync. See `refreshLiveBalancesForItem`.
 */
export async function markItemBalanceRefreshed(id: string, at: number): Promise<void> {
  const db = getDb();
  await db.update(plaidItems).set({ balanceRefreshedAt: at }).where(eq(plaidItems.id, id)).run();
}

/**
 * Stamp the transactions-refresh throttle for an item (migration 0039). Same
 * attempt-not-success contract as `markItemBalanceRefreshed`: an institution
 * that doesn't support on-demand refresh, or is down, must back off rather than
 * be retried on every sync.
 */
export async function markItemTransactionsRefreshed(id: string, at: number): Promise<void> {
  const db = getDb();
  await db
    .update(plaidItems)
    .set({ transactionsRefreshedAt: at })
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
        // Deliberately NOT coalesced, unlike limitCents below.
        // `availableBalanceCents` is only meaningful paired with the
        // `balanceCents` written in this same statement — their difference is
        // the pending float. Holding an older available while current moves
        // forward would manufacture a float no bank ever reported, and that
        // fiction holds real cash out of the projection. An explicit null
        // (institution stopped computing it) must therefore clear it;
        // `undefined` from a caller that doesn't deal in balances is dropped
        // by drizzle and leaves the column alone.
        availableBalanceCents: data.availableBalanceCents,
        // Never let a payload without a limit erase one we already know.
        // `/transactions/sync` account objects frequently carry no `limit`
        // even when `/accounts/get` does, and callers that don't deal in
        // limits at all would otherwise null it out on every write.
        limitCents: sql`coalesce(excluded.limit_cents, ${plaidAccounts.limitCents})`,
        updatedAt: Date.now(),
      },
    })
    .run();
}

/**
 * Seed a linked card's credit line from the Plaid-reported limit, but ONLY
 * while the card has none. Once the user enters a limit by hand it is theirs —
 * sync never overwrites it (same manual-wins rule as paid records and due-date
 * overrides). Returns true when a value was actually written.
 */
export async function seedCreditLimitFromPlaid(
  cardId: string,
  limitCents: number,
): Promise<boolean> {
  if (!Number.isFinite(limitCents) || limitCents <= 0) return false;
  const db = getDb();
  const result = await db
    .update(creditCards)
    .set({ creditLimitCents: limitCents, updatedAt: Date.now() })
    .where(and(eq(creditCards.id, cardId), isNull(creditCards.creditLimitCents)))
    .run();
  return result.changes > 0;
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
  let linkedAccountBalance: number | null | undefined;

  if (plaidAccountId !== null) {
    const owned = await db
      .select({ id: plaidAccounts.id, balanceCents: plaidAccounts.balanceCents })
      .from(plaidAccounts)
      .where(and(eq(plaidAccounts.userId, userId), eq(plaidAccounts.id, plaidAccountId)))
      .get();
    if (!owned) return { ok: false, error: "Plaid account not found" };
    linkedAccountBalance = owned.balanceCents;

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
    .set({
      plaidAccountId,
      ...(linkedAccountBalance != null
        ? { currentBalanceCents: Math.max(0, linkedAccountBalance) }
        : {}),
      updatedAt: Date.now(),
    })
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

export type StatementUpsertResult = {
  /** A row was inserted or updated (drives sync progress counters). */
  changed: boolean;
};

/**
 * Upsert a statement keyed by (cardId, statementDate), falling back to
 * (cardId, dueDate) when an issuer shifts the reported statement date for the
 * same payable cycle. Uses the unique index added in 0005 so exact re-syncs
 * are idempotent. Will not overwrite a paid record with empty paid fields —
 * manual reconciliation wins over Plaid's read-only snapshot.
 *
 * Statement paid state never changes promotional balances. Issuer
 * reconciliation is the only reliable source for actual promo allocation.
 */
export async function upsertCreditCardStatementByDate(
  cardId: string,
  data: {
    statementDate: string;
    dueDate: string;
    statementBalanceCents: number;
    minimumPaymentCents?: number | null;
    paidAmountCents?: number | null;
    paidDate?: string | null;
    liveBalanceCents?: number | null;
  },
): Promise<StatementUpsertResult> {
  const db = getDb();
  let existing = await db
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
    existing = await db
      .select()
      .from(creditCardStatements)
      .where(
        and(
          eq(creditCardStatements.cardId, cardId),
          eq(creditCardStatements.dueDate, data.dueDate),
        ),
      )
      .orderBy(desc(creditCardStatements.statementDate))
      .get();
  }

  if (
    data.statementBalanceCents === 0 &&
    (data.minimumPaymentCents ?? 0) <= 0 &&
    (data.liveBalanceCents ?? 0) > 0
  ) {
    const prior = await db
      .select()
      .from(creditCardStatements)
      .where(
        and(
          eq(creditCardStatements.cardId, cardId),
          lt(creditCardStatements.statementDate, data.statementDate),
        ),
      )
      .orderBy(desc(creditCardStatements.statementDate))
      .get();
    const priorUnpaidCents = prior
      ? Math.max(0, prior.statementBalanceCents - (prior.paidAmountCents ?? 0))
      : 0;
    if (priorUnpaidCents > 0) {
      log.warn(
        `plaid-liabilities: ignored $0 statement for card ${cardId} on ${data.statementDate}; prior unpaid carryover ${priorUnpaidCents} cents with live balance ${data.liveBalanceCents} cents`,
      );
      return { changed: false };
    }
  }

  if (!existing) {
    await db
      .insert(creditCardStatements)
      .values({
        id: newId(),
        cardId,
        statementDate: data.statementDate,
        dueDate: data.dueDate,
        statementBalanceCents: data.statementBalanceCents,
        minimumPaymentCents: data.minimumPaymentCents ?? null,
        paidAmountCents: data.paidAmountCents ?? null,
        paidDate: data.paidDate ?? null,
      })
      .run();
    return { changed: true };
  }

  // Don't clobber a manual paid record with Plaid-only data.
  const keepPaid = existing.paidAmountCents != null && (data.paidAmountCents ?? null) == null;
  await db
    .update(creditCardStatements)
    .set({
      statementDate: data.statementDate,
      // A hand-edited due date survives Plaid syncs (manual wins, same
      // principle as paid records above).
      ...(existing.dueDateUserOverride ? {} : { dueDate: data.dueDate }),
      statementBalanceCents: data.statementBalanceCents,
      minimumPaymentCents: data.minimumPaymentCents ?? null,
      ...(keepPaid
        ? {}
        : { paidAmountCents: data.paidAmountCents ?? null, paidDate: data.paidDate ?? null }),
    })
    .where(eq(creditCardStatements.id, existing.id))
    .run();
  return { changed: true };
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
  const activeAccountIds = (
    await db
      .select({ id: plaidAccounts.id })
      .from(plaidAccounts)
      .innerJoin(plaidItems, eq(plaidAccounts.itemId, plaidItems.id))
      .where(and(eq(plaidAccounts.userId, userId), eq(plaidItems.isActive, true)))
      .all()
  ).map((account) => account.id);
  if (activeAccountIds.length === 0) return [];

  if (status === "all") {
    return db
      .select()
      .from(plaidTransactionDrafts)
      .where(
        and(
          eq(plaidTransactionDrafts.userId, userId),
          inArray(plaidTransactionDrafts.accountId, activeAccountIds),
        ),
      )
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
        inArray(plaidTransactionDrafts.accountId, activeAccountIds),
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
        // A user-actioned draft (approved into a real expense or promo) keeps
        // its kind: a Plaid re-categorization arriving via `modified` must not
        // flip a row whose money is already represented elsewhere — same guard
        // the sync backfill applies on its path. Unqualified/table-qualified
        // columns in DO UPDATE refer to the EXISTING row in SQLite.
        kind: sql`CASE
          WHEN ${plaidTransactionDrafts.linkedExpenseId} IS NOT NULL
            OR ${plaidTransactionDrafts.linkedPromoId} IS NOT NULL
          THEN ${plaidTransactionDrafts.kind}
          ELSE ${data.kind ?? "expense"}
        END`,
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
    | "date"
    | "description"
    | "amountCents"
    | "plaidCategory"
    | "merchantName"
    | "originalDescription"
    | "kind"
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
 * Approved Plaid drafts for accounts flagged useAsStartingBalance, in
 * [startIso, endIso] inclusive. Used by projection-server to reconstruct
 * historical balances backward from the live linked balance: each draft's
 * amountCents represents a real posted cash movement on the day it occurred.
 *
 * Excludes pending_review and dismissed drafts. Includes card_payment kind —
 * a payment to a credit card still leaves the depository account.
 */
export async function listStartingBalanceDraftsInRange(
  userId: string,
  startIso: string,
  endIso: string,
): Promise<
  Array<{
    id: string;
    accountId: string;
    date: string;
    description: string;
    merchantName: string | null;
    amountCents: number;
    linkedBillId: string | null;
    billMatchExcluded: boolean;
  }>
> {
  const db = getDb();
  const accountRows = await db
    .select({ id: plaidAccounts.id })
    .from(plaidAccounts)
    .where(
      and(
        eq(plaidAccounts.userId, userId),
        eq(plaidAccounts.useAsStartingBalance, true),
      ),
    )
    .all();
  if (accountRows.length === 0) return [];
  const accountIds = accountRows.map((r) => r.id);
  return db
    .select({
      id: plaidTransactionDrafts.id,
      accountId: plaidTransactionDrafts.accountId,
      date: plaidTransactionDrafts.date,
      description: plaidTransactionDrafts.description,
      merchantName: plaidTransactionDrafts.merchantName,
      amountCents: plaidTransactionDrafts.amountCents,
      linkedBillId: plaidTransactionDrafts.linkedBillId,
      billMatchExcluded: plaidTransactionDrafts.billMatchExcluded,
    })
    .from(plaidTransactionDrafts)
    .where(
      and(
        eq(plaidTransactionDrafts.userId, userId),
        eq(plaidTransactionDrafts.status, "approved" as const),
        // POSTED only. A pending draft is a claim that money is moving, and
        // letting one settle a bill occurrence would RELEASE that occurrence's
        // held cash on the strength of a transaction that can still change or
        // disappear — the exact double-count-in-the-user's-favour that §17b
        // exists to prevent. Pending cash is held via getPendingDraftOutflow
        // instead, which is the opposite direction.
        eq(plaidTransactionDrafts.pending, false),
        inArray(plaidTransactionDrafts.accountId, accountIds),
        gte(plaidTransactionDrafts.date, startIso),
        lte(plaidTransactionDrafts.date, endIso),
      ),
    )
    .orderBy(asc(plaidTransactionDrafts.date))
    .all();
}

export type CardTransaction = {
  id: string;
  accountId: string;
  date: string;
  description: string;
  merchantName: string | null;
  plaidCategory: string | null;
  amountCents: number;
};

/**
 * Posted charges on the given Plaid accounts within a date range — the raw
 * material for "what has hit this card since its last statement closed".
 *
 * Scope decisions:
 *  - `kind = 'expense'` only. A `card_payment` moves the balance down but is
 *    not spend; counting it would net the cycle out to nothing.
 *  - Refunds/credits ride along as negative `amountCents` (Plaid's sign
 *    convention), so a returned purchase correctly reduces cycle spend.
 *  - Dismissed drafts are excluded, matching every other consumer of this
 *    table — dismissing is the user saying "don't count this".
 *  - Pending drafts are excluded, keeping the "posted charges" contract in the
 *    first line of this doc literally true. A pending charge's amount is not
 *    final (tips, holds, and fuel pre-auths all settle at a different figure),
 *    so counting one would make cycle spend wrong in an unpredictable
 *    direction rather than merely conservative.
 */
export async function listCardTransactionsInRange(
  userId: string,
  accountIds: string[],
  startIso: string,
  endIso: string,
): Promise<CardTransaction[]> {
  if (accountIds.length === 0) return [];
  const db = getDb();
  return db
    .select({
      id: plaidTransactionDrafts.id,
      accountId: plaidTransactionDrafts.accountId,
      date: plaidTransactionDrafts.date,
      description: plaidTransactionDrafts.description,
      merchantName: plaidTransactionDrafts.merchantName,
      plaidCategory: plaidTransactionDrafts.plaidCategory,
      amountCents: plaidTransactionDrafts.amountCents,
    })
    .from(plaidTransactionDrafts)
    .where(
      and(
        eq(plaidTransactionDrafts.userId, userId),
        eq(plaidTransactionDrafts.kind, "expense" as const),
        ne(plaidTransactionDrafts.status, "dismissed" as const),
        eq(plaidTransactionDrafts.pending, false),
        inArray(plaidTransactionDrafts.accountId, accountIds),
        gte(plaidTransactionDrafts.date, startIso),
        lte(plaidTransactionDrafts.date, endIso),
      ),
    )
    .orderBy(desc(plaidTransactionDrafts.date))
    .all();
}

/**
 * Set (or clear, with null) the manual bill link on a draft. The bill
 * reconciliation treats a linked draft as paying that bill, and its
 * descriptor becomes a learned alias for future months.
 */
export async function setPlaidDraftBillLink(
  userId: string,
  id: string,
  billId: string | null,
): Promise<PlaidTransactionDraftRow | undefined> {
  const db = getDb();
  await db
    .update(plaidTransactionDrafts)
    // An explicit link supersedes any earlier "not this bill" rejection, so
    // the exclusion clears rather than silently fighting the manual link.
    .set(billId != null ? { linkedBillId: billId, billMatchExcluded: false } : { linkedBillId: billId })
    .where(
      and(
        eq(plaidTransactionDrafts.userId, userId),
        eq(plaidTransactionDrafts.id, id),
      ),
    )
    .run();
  return getPlaidDraft(userId, id);
}

/**
 * Mark a draft as rejected from heuristic bill matching ("not this bill"),
 * or re-allow it with `excluded=false`. A manual link (linkedBillId) is
 * unaffected and always wins in the matcher.
 */
export async function setPlaidDraftBillMatchExcluded(
  userId: string,
  id: string,
  excluded: boolean,
): Promise<PlaidTransactionDraftRow | undefined> {
  const db = getDb();
  await db
    .update(plaidTransactionDrafts)
    .set({ billMatchExcluded: excluded })
    .where(
      and(
        eq(plaidTransactionDrafts.userId, userId),
        eq(plaidTransactionDrafts.id, id),
      ),
    )
    .run();
  return getPlaidDraft(userId, id);
}

/**
 * Descriptors of every draft the user pointed at a bill — the reconciliation's
 * learned-alias source. Small by construction (one row per manual assignment
 * ever made), so no pagination.
 *
 * Covers BOTH ways of assigning: a whole-transaction `linked_bill_id`, and a
 * split allocation naming a bill. Teaching the wording is the point of either
 * gesture, so a user who splits a transfer gets the same automatic matching
 * next month as one who links it.
 */
export async function listBillLinkDescriptors(
  userId: string,
): Promise<Array<{ billId: string; description: string; merchantName: string | null }>> {
  const db = getDb();
  const linked = await db
    .select({
      billId: plaidTransactionDrafts.linkedBillId,
      description: plaidTransactionDrafts.description,
      merchantName: plaidTransactionDrafts.merchantName,
    })
    .from(plaidTransactionDrafts)
    .where(
      and(
        eq(plaidTransactionDrafts.userId, userId),
        isNotNull(plaidTransactionDrafts.linkedBillId),
      ),
    )
    .all();
  const allocated = await db
    .select({
      billId: draftAllocations.targetId,
      description: plaidTransactionDrafts.description,
      merchantName: plaidTransactionDrafts.merchantName,
    })
    .from(draftAllocations)
    .innerJoin(plaidTransactionDrafts, eq(plaidTransactionDrafts.id, draftAllocations.draftId))
    .where(
      and(eq(draftAllocations.userId, userId), eq(draftAllocations.targetKind, "bill")),
    )
    .all();
  return [...linked, ...allocated].filter(
    (r): r is typeof r & { billId: string } => r.billId != null,
  );
}

// ── draft allocations (one transaction, several obligations) ─────────────────

export async function listDraftAllocationsForUser(
  userId: string,
): Promise<DraftAllocationRow[]> {
  const db = getDb();
  return db
    .select()
    .from(draftAllocations)
    .where(eq(draftAllocations.userId, userId))
    .all();
}

export async function listDraftAllocations(
  userId: string,
  draftId: string,
): Promise<DraftAllocationRow[]> {
  const db = getDb();
  return db
    .select()
    .from(draftAllocations)
    .where(and(eq(draftAllocations.userId, userId), eq(draftAllocations.draftId, draftId)))
    .all();
}

/**
 * Replace a draft's whole split in one shot. Replace rather than merge: the
 * split is a single statement about one transaction, and a partial update
 * would leave a stale target silently claiming money. An empty list clears it,
 * returning the draft to heuristic matching.
 */
export async function replaceDraftAllocations(
  userId: string,
  draftId: string,
  allocations: ReadonlyArray<{
    targetKind: DraftAllocationTargetKind;
    targetId: string;
    targetDate: string;
    amountCents: number;
  }>,
): Promise<DraftAllocationRow[]> {
  const db = getDb();
  db.transaction((tx) => {
    tx.delete(draftAllocations)
      .where(and(eq(draftAllocations.userId, userId), eq(draftAllocations.draftId, draftId)))
      .run();
    for (const a of allocations) {
      tx.insert(draftAllocations)
        .values({
          id: newId(),
          userId,
          draftId,
          targetKind: a.targetKind,
          targetId: a.targetId,
          targetDate: a.targetDate,
          amountCents: a.amountCents,
        })
        .run();
    }
  });
  return listDraftAllocations(userId, draftId);
}

/**
 * Sums the balances of every account flagged useAsStartingBalance=true, or
 * returns null if no account is opted in. Used by projection-server to
 * substitute the user's live bank balance for the manual startingBalanceCents.
 *
 * Multiple opted-in accounts (e.g. a household with checking + savings both
 * marked) sum into a single starting balance; nulls are skipped (an account
 * Plaid hasn't returned a balance for yet contributes 0, not the override
 * being abandoned).
 */
export async function getPrimaryLinkedBalance(userId: string): Promise<number | null> {
  const snapshot = await getLinkedBalanceSnapshot(userId);
  return snapshot?.balanceCents ?? null;
}

export type LinkedBalanceSnapshot = {
  /** Σ Plaid `balances.current` across opted-in accounts. */
  balanceCents: number;
  /**
   * Σ max(0, current − available) across opted-in accounts — the bank's own
   * measure of money that has left but hasn't posted. Accounts whose
   * institution doesn't compute an available balance contribute 0, so this is
   * always a floor, never a guess. Clamped per account because `available`
   * legitimately exceeds `current` when the bank folds an overdraft line or a
   * pending deposit into it; we only ever count pending OUTflows.
   */
  pendingOutflowCents: number;
};

/**
 * Both halves of the linked starting balance in one read. They must come from
 * the same query: `pendingOutflowCents` is a difference, so computing it from
 * a second, later read of the same rows could straddle a sync.
 */
export async function getLinkedBalanceSnapshot(
  userId: string,
): Promise<LinkedBalanceSnapshot | null> {
  const db = getDb();
  const rows = await db
    .select({
      balanceCents: plaidAccounts.balanceCents,
      availableBalanceCents: plaidAccounts.availableBalanceCents,
    })
    .from(plaidAccounts)
    .where(
      and(
        eq(plaidAccounts.userId, userId),
        eq(plaidAccounts.useAsStartingBalance, true),
      ),
    )
    .all();
  if (rows.length === 0) return null;
  let balanceCents = 0;
  let pendingOutflowCents = 0;
  for (const r of rows) {
    const current = r.balanceCents ?? 0;
    balanceCents += current;
    if (r.balanceCents != null && r.availableBalanceCents != null) {
      pendingOutflowCents += Math.max(0, r.balanceCents - r.availableBalanceCents);
    }
  }
  return { balanceCents, pendingOutflowCents };
}

/**
 * Σ pending OUTflows across starting-balance accounts, from Plaid's own pending
 * transaction rows — the second, independent measure of "money that has left
 * but hasn't posted".
 *
 * Why this exists alongside `getLinkedBalanceSnapshot.pendingOutflowCents`:
 * that one is `current − available`, which is $0 at any institution that
 * doesn't net pending debits out of `available`. Both credit unions anchoring
 * this app's projections do exactly that (Alliant and Navy Federal each report
 * `available == current` on checking), so the bank-float layer is structurally
 * blind there while Plaid may still be reporting the individual pending rows.
 *
 * Outflows only (`amountCents > 0`, Plaid's sign convention): a pending deposit
 * is money arriving, and counting it here would release cash rather than hold
 * it. Dismissed drafts are excluded, which is also what retires a pending row
 * once its posted successor supersedes it.
 *
 * These dollars OVERLAP the bank float — they are two views of the same
 * pending set, never two pools. Callers must combine with max(), never a sum.
 */
export async function getPendingDraftOutflow(userId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ amountCents: plaidTransactionDrafts.amountCents })
    .from(plaidTransactionDrafts)
    .innerJoin(plaidAccounts, eq(plaidTransactionDrafts.accountId, plaidAccounts.id))
    .where(
      and(
        eq(plaidTransactionDrafts.userId, userId),
        eq(plaidTransactionDrafts.pending, true),
        ne(plaidTransactionDrafts.status, "dismissed" as const),
        eq(plaidAccounts.useAsStartingBalance, true),
      ),
    )
    .all();
  return rows.reduce((sum, r) => sum + Math.max(0, r.amountCents), 0);
}

// ── net worth ────────────────────────────────────────────────────────────────

export type NetWorthComponents = {
  assetsCents: number;
  depositoryBalanceCents: number;
  creditCardDebtCents: number;
  promoDebtCents: number;
  netWorthCents: number;
};

export async function getNetWorthComponents(userId: string): Promise<NetWorthComponents> {
  const db = getDb();

  // Sum active assets
  const assetRows = await db
    .select({ valueCents: assets.valueCents })
    .from(assets)
    .where(and(eq(assets.userId, userId), eq(assets.isActive, true)))
    .all();
  const assetsCents = assetRows.reduce((s, r) => s + r.valueCents, 0);

  // Sum Plaid depository balances
  const allAccounts = await db
    .select({
      id: plaidAccounts.id,
      type: plaidAccounts.type,
      balanceCents: plaidAccounts.balanceCents,
    })
    .from(plaidAccounts)
    .where(and(eq(plaidAccounts.userId, userId), eq(plaidAccounts.syncEnabled, true)))
    .all();
  const depositoryBalanceCents = allAccounts
    .filter((a) => a.type === "depository")
    .reduce((s, a) => s + (a.balanceCents ?? 0), 0);

  // Split card debt into standard and promotional portions without counting
  // promo principal twice. A card's current balance already includes its promo
  // purchases; promo rows remain useful for the report breakdown and for cards
  // without a current balance.
  const cards = await listCreditCards(userId, false);
  const promos = await listPromos(userId, false);
  const promoRemainingByCard = new Map<string, number>();
  for (const promo of promos) {
    promoRemainingByCard.set(
      promo.cardId,
      (promoRemainingByCard.get(promo.cardId) ?? 0) + promo.remainingAmountCents,
    );
  }
  const promoDebtCents = promos.reduce(
    (s, p) => s + p.remainingAmountCents,
    0,
  );
  const linkedBalanceByAccountId = new Map(
    allAccounts
      .filter((account) => account.type === "credit")
      .map((account) => [account.id, account.balanceCents] as const),
  );
  const creditCardDebtCents = cards.reduce((sum, card) => {
    const linkedBalance = card.plaidAccountId
      ? linkedBalanceByAccountId.get(card.plaidAccountId)
      : null;
    const balance = linkedBalance ?? card.currentBalanceCents ?? 0;
    const embeddedPromo = promoRemainingByCard.get(card.id) ?? 0;
    return sum + Math.max(0, balance - embeddedPromo);
  }, 0);

  const netWorthCents =
    assetsCents + depositoryBalanceCents - creditCardDebtCents - promoDebtCents;

  return {
    assetsCents,
    depositoryBalanceCents,
    creditCardDebtCents,
    promoDebtCents,
    netWorthCents,
  };
}

// ── export/import ─────────────────────────────────────────────────────────────

/**
 * Backup payload. Schema version bumps when the shape changes.
 *
 *   v3: settings, bills, billPaymentOverrides, creditCardPaymentOverrides,
 *       paychecks, extras, categories, creditCards, creditCardStatements
 *   v4: + creditCardPromos, creditCardPromoPayments
 *   v5: + variableBills, variableBillCards
 *   v6: + categories.budgetAmountCents
 *   v10: + billPaymentStates (per-occurrence sent / paid-externally marks)
 *
 * Plaid items / accounts / drafts are intentionally NOT exported — the
 * access tokens are encrypted with a per-deployment PLAID_ENCRYPTION_KEY,
 * and the institution session is single-use. After restore the user
 * relinks each institution.
 */
export async function exportAll(userId: string) {
  const db = getDb();
  const [s, b, bo, bps, vb, vbc, cpo, p, e, c, cc, ccs, ccp, ccpp, a] = await Promise.all([
    getSettings(userId),
    db.select().from(bills).where(eq(bills.userId, userId)).all(),
    db.select().from(billPaymentOverrides).where(eq(billPaymentOverrides.userId, userId)).all(),
    db.select().from(billPaymentStates).where(eq(billPaymentStates.userId, userId)).all(),
    db.select().from(variableBills).where(eq(variableBills.userId, userId)).all(),
    db.select().from(variableBillCards).where(eq(variableBillCards.userId, userId)).all(),
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
    db.select().from(creditCardPromos).where(eq(creditCardPromos.userId, userId)).all(),
    db.select().from(creditCardPromoPayments).where(eq(creditCardPromoPayments.userId, userId)).all(),
    db.select().from(assets).where(eq(assets.userId, userId)).all(),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: 10,
    settings: s,
    bills: b,
    billPaymentOverrides: bo,
    billPaymentStates: bps,
    variableBills: vb,
    variableBillCards: vbc,
    creditCardPaymentOverrides: cpo,
    paychecks: p,
    extras: e,
    categories: c,
    creditCards: cc,
    creditCardStatements: ccs,
    creditCardPromos: ccp,
    creditCardPromoPayments: ccpp,
    assets: a,
  };
}

import type { BackupImportInput } from "./validation";

/**
 * Build the set of valid IDs that child rows may reference inside a backup
 * payload, then verify every cross-row reference points either at a payload
 * row or at one of the user's existing rows that survives the restore (only
 * `paidViaCardId` survives — cards owned by other users are NEVER acceptable
 * because the import is single-user-scoped).
 *
 * Throws on the first violation with a stable string the route maps to a 400.
 */
async function validateImportGraph(
  userId: string,
  payload: BackupImportInput,
): Promise<{ cardIds: Set<string>; billIds: Set<string>; promoIds: Set<string>; variableBillIds: Set<string> }> {
  const cardIds = new Set<string>();
  for (const c of payload.creditCards ?? []) cardIds.add(c.id);

  const billIds = new Set<string>();
  for (const b of payload.bills ?? []) {
    if (b.id) billIds.add(b.id);
  }

  const promoIds = new Set<string>();
  for (const p of payload.creditCardPromos ?? []) {
    if (p.id) promoIds.add(p.id);
  }

  const variableBillIds = new Set<string>();
  for (const v of payload.variableBills ?? []) variableBillIds.add(v.id);

  // Reject duplicate ids within a single collection so the dedup-by-set above
  // doesn't quietly mask collisions that would alias rows on insert.
  const seenCardIds = new Set<string>();
  for (const c of payload.creditCards ?? []) {
    if (seenCardIds.has(c.id)) throw new Error(`duplicate creditCard id ${c.id}`);
    seenCardIds.add(c.id);
  }
  const seenVbIds = new Set<string>();
  for (const v of payload.variableBills ?? []) {
    if (seenVbIds.has(v.id)) throw new Error(`duplicate variableBill id ${v.id}`);
    seenVbIds.add(v.id);
  }

  const ensureCard = (cardId: string, where: string) => {
    if (!cardIds.has(cardId)) throw new Error(`${where} references unknown cardId ${cardId}`);
  };
  const ensureBill = (billId: string, where: string) => {
    if (!billIds.has(billId)) throw new Error(`${where} references unknown billId ${billId}`);
  };
  const ensurePromo = (promoId: string, where: string) => {
    if (!promoIds.has(promoId)) throw new Error(`${where} references unknown promoId ${promoId}`);
  };
  const ensureVariableBill = (vbId: string, where: string) => {
    if (!variableBillIds.has(vbId)) {
      throw new Error(`${where} references unknown variableBillId ${vbId}`);
    }
  };

  for (const b of payload.bills ?? []) {
    if (b.paidViaCardId) ensureCard(b.paidViaCardId, "bills.paidViaCardId");
  }
  for (const e of payload.extras ?? []) {
    if (e.paidViaCardId) ensureCard(e.paidViaCardId, "extras.paidViaCardId");
  }
  for (const o of payload.billPaymentOverrides ?? []) ensureBill(o.billId, "billPaymentOverrides.billId");
  for (const s of payload.billPaymentStates ?? []) ensureBill(s.billId, "billPaymentStates.billId");
  for (const o of payload.creditCardPaymentOverrides ?? []) {
    ensureCard(o.cardId, "creditCardPaymentOverrides.cardId");
  }
  for (const s of payload.creditCardStatements ?? []) ensureCard(s.cardId, "creditCardStatements.cardId");
  for (const p of payload.creditCardPromos ?? []) ensureCard(p.cardId, "creditCardPromos.cardId");
  for (const link of payload.variableBillCards ?? []) {
    ensureVariableBill(link.variableBillId, "variableBillCards.variableBillId");
    ensureCard(link.cardId, "variableBillCards.cardId");
  }
  for (const pp of payload.creditCardPromoPayments ?? []) {
    ensurePromo(pp.promoId, "creditCardPromoPayments.promoId");
  }

  return { cardIds, billIds, promoIds, variableBillIds };
}

/**
 * Restore a backup over the current user's data. Runs as a single SQLite
 * transaction so a failure mid-restore reverts every delete and insert —
 * the user never observes a half-imported state.
 *
 * Validation rules:
 *   - Caller is responsible for Zod-parsing the payload first (see
 *     `backupImportSchema`).
 *   - Foreign keys inside the payload (statements → cards, overrides →
 *     bills/cards, etc.) MUST resolve to a row inside the same payload.
 *     Cross-user references are rejected before any write fires.
 *   - Plaid items / accounts / drafts are intentionally not touched —
 *     re-linking is how the user gets live data back, and exposing those
 *     IDs in a backup would let one user's import overwrite another's
 *     Plaid linkage.
 */
/**
 * Detect bills in an import payload that match existing bills by composite key
 * (name + anchorDate + amountCents). Returns a list of human-readable warnings.
 */
export function detectDuplicateBills(
  existingBills: BillRow[],
  incomingBills: BackupImportInput["bills"],
): string[] {
  if (!incomingBills?.length) return [];
  const existingKeys = new Set(
    existingBills.map((b) => `${b.name}|${b.anchorDate}|${b.amountCents}`),
  );
  const warnings: string[] = [];
  for (const b of incomingBills) {
    const key = `${b.name}|${b.anchorDate}|${b.amountCents}`;
    if (existingKeys.has(key)) {
      warnings.push(`Duplicate bill: "${b.name}" on ${b.anchorDate} for ${b.amountCents} cents`);
    }
  }
  return warnings;
}

export async function importAll(userId: string, payload: BackupImportInput): Promise<void> {
  const db = getDb();
  await validateImportGraph(userId, payload);

  db.transaction((tx) => {
    // Delete in dependency order (children before parents). Plaid items are
    // intentionally untouched — re-linking is the user's path back to live data.
    tx.delete(creditCardPromoPayments).where(eq(creditCardPromoPayments.userId, userId)).run();
    tx.delete(creditCardPromos).where(eq(creditCardPromos.userId, userId)).run();
    tx.delete(variableBillCards).where(eq(variableBillCards.userId, userId)).run();
    tx.delete(variableBills).where(eq(variableBills.userId, userId)).run();
    tx.delete(creditCardPaymentOverrides).where(eq(creditCardPaymentOverrides.userId, userId)).run();
    // creditCardStatements have no userId column; cascade off creditCards delete
    // when we delete cards next. But we have to clear them via the join because
    // the cardId FK references creditCards.id with ON DELETE CASCADE — that
    // deletes statements for the user's cards automatically. We rely on it.
    tx.delete(creditCards).where(eq(creditCards.userId, userId)).run();
    tx.delete(billPaymentOverrides).where(eq(billPaymentOverrides.userId, userId)).run();
    tx.delete(billPaymentStates).where(eq(billPaymentStates.userId, userId)).run();
    tx.delete(bills).where(eq(bills.userId, userId)).run();
    tx.delete(paychecks).where(eq(paychecks.userId, userId)).run();
    tx.delete(oneTimeExpenses).where(eq(oneTimeExpenses.userId, userId)).run();
    tx.delete(assets).where(eq(assets.userId, userId)).run();

    importInsideTransaction(tx, userId, payload);
  });
}

/**
 * Insert side of the restore. Runs inside the import transaction so any
 * insert error rolls back the deletes above.
 */
function importInsideTransaction(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  userId: string,
  payload: BackupImportInput,
): void {
  // Categories: only replace if provided. Backups created before categories
  // were exportable would otherwise wipe the user's category list.
  if (Array.isArray(payload.categories)) {
    tx.delete(categories).where(eq(categories.userId, userId)).run();
    for (const c of payload.categories) {
      tx.insert(categories).values({
        id: c.id ?? newId(),
        userId,
        name: c.name,
        color: c.color,
        kind: c.kind,
        budgetAmountCents: c.budgetAmountCents ?? 0,
      }).run();
    }
  }

  // Insert in dependency order (parents before children). Cards first so
  // bills.paidViaCardId / extras.paidViaCardId / statements.cardId all
  // resolve. Plaid account links are nulled because the Plaid items aren't
  // exported — restoring on a fresh deployment with a different
  // PLAID_ENCRYPTION_KEY would otherwise leave dangling references.
  for (const card of payload.creditCards ?? []) {
    tx.insert(creditCards).values({
      id: card.id,
      userId,
      name: card.name,
      statementDay: card.statementDay,
      statementCycleMode: card.statementCycleMode ?? "calendar_day",
      statementCycleAnchorDate: card.statementCycleAnchorDate ?? null,
      statementCycleIntervalDays: card.statementCycleIntervalDays ?? 31,
      dueDay: card.dueDay,
      currentBalanceCents: card.currentBalanceCents ?? null,
      autoPay: card.autoPay ?? false,
      notes: card.notes ?? null,
      isActive: card.isActive ?? true,
      plaidAccountId: null,
    }).run();
  }

  for (const s of payload.creditCardStatements ?? []) {
    tx.insert(creditCardStatements).values({
      id: s.id ?? newId(),
      cardId: s.cardId,
      statementDate: s.statementDate,
      dueDate: s.dueDate,
      statementBalanceCents: s.statementBalanceCents,
      minimumPaymentCents: s.minimumPaymentCents ?? null,
      paidAmountCents: s.paidAmountCents ?? null,
      paidDate: s.paidDate ?? null,
      notes: s.notes ?? null,
      settledByDraftId: s.settledByDraftId ?? null,
    }).run();
  }

  for (const p of payload.creditCardPromos ?? []) {
    tx.insert(creditCardPromos).values({
      id: p.id ?? newId(),
      userId,
      cardId: p.cardId,
      description: p.description,
      originalAmountCents: p.originalAmountCents,
      remainingAmountCents: p.remainingAmountCents,
      startDate: p.startDate,
      endDate: p.endDate,
      monthlyPaymentCents: p.monthlyPaymentCents ?? null,
      notes: p.notes ?? null,
      isActive: p.isActive ?? true,
      authoritativeSource: p.authoritativeSource ?? null,
    }).run();
  }

  for (const b of payload.variableBills ?? []) {
    tx.insert(variableBills).values({
      id: b.id,
      userId,
      name: b.name,
      category: b.category ?? "Other",
      amountCents: b.amountCents,
      intervalMonths: b.intervalMonths,
      anchorDate: b.anchorDate,
      notes: b.notes ?? null,
      isActive: b.isActive ?? true,
    }).run();
  }
  for (const link of payload.variableBillCards ?? []) {
    tx.insert(variableBillCards).values({
      id: link.id ?? newId(),
      userId,
      variableBillId: link.variableBillId,
      cardId: link.cardId,
    }).run();
  }

  for (const pp of payload.creditCardPromoPayments ?? []) {
    tx.insert(creditCardPromoPayments).values({
      id: pp.id ?? newId(),
      userId,
      promoId: pp.promoId,
      dueDate: pp.dueDate,
      amountCents: pp.amountCents,
      note: pp.note ?? null,
    }).run();
  }

  // Bills: support legacy frequency/dueDay/dueMonth backups (pre-0006) by
  // converting to the new (intervalMonths, anchorDate) shape. New backups
  // already supply both fields.
  const monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (const b of payload.bills ?? []) {
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
    tx.insert(bills).values({
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
  for (const o of payload.billPaymentOverrides ?? []) {
    tx.insert(billPaymentOverrides).values({
      id: o.id ?? newId(),
      userId,
      billId: o.billId,
      dueDate: o.dueDate,
      amountCents: o.amountCents,
      notes: o.notes ?? null,
    }).run();
  }
  for (const s of payload.billPaymentStates ?? []) {
    tx.insert(billPaymentStates).values({
      id: s.id ?? newId(),
      userId,
      billId: s.billId,
      dueDate: s.dueDate,
      state: s.state,
      amountCents: s.amountCents ?? null,
      markedDate: s.markedDate,
      notes: s.notes ?? null,
    }).run();
  }
  for (const o of payload.creditCardPaymentOverrides ?? []) {
    tx.insert(creditCardPaymentOverrides).values({
      id: o.id ?? newId(),
      userId,
      cardId: o.cardId,
      dueDate: o.dueDate,
      amountCents: o.amountCents,
      notes: o.notes ?? null,
    }).run();
  }
  for (const p of payload.paychecks ?? []) {
    tx.insert(paychecks).values({
      id: p.id ?? newId(),
      userId,
      payDate: p.payDate,
      amountCents: p.amountCents,
      note: p.note ?? null,
      actualReceived: p.actualReceived ?? false,
      actualAmountCents: p.actualAmountCents ?? null,
      settledByDraftId: p.settledByDraftId ?? null,
      isActive: p.isActive ?? true,
    }).run();
  }
  for (const e of payload.extras ?? []) {
    tx.insert(oneTimeExpenses).values({
      id: e.id ?? newId(),
      userId,
      date: e.date,
      description: e.description,
      amountCents: e.amountCents,
      category: e.category ?? "Other",
      paidViaCardId: e.paidViaCardId ?? null,
      notes: e.notes ?? null,
      isActive: e.isActive ?? true,
    }).run();
  }

  for (const a of payload.assets ?? []) {
    tx.insert(assets).values({
      id: a.id ?? newId(),
      userId,
      name: a.name,
      valueCents: a.valueCents,
      category: a.category ?? "other",
      notes: a.notes ?? null,
      asOfDate: a.asOfDate,
      isActive: a.isActive ?? true,
    }).run();
  }
}

// ── Web-push subscriptions ────────────────────────────────────────────────────

export async function listPushSubscriptions(userId: string): Promise<PushSubscriptionRow[]> {
  const db = getDb();
  return db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all();
}

export async function listAllPushSubscriptions(): Promise<PushSubscriptionRow[]> {
  const db = getDb();
  return db.select().from(pushSubscriptions).all();
}

/**
 * Idempotent per endpoint: re-subscribing from the same browser updates the
 * keys in place (push services rotate keys on re-subscribe) and re-homes the
 * row to the signed-in user.
 */
export async function upsertPushSubscription(
  userId: string,
  data: { endpoint: string; p256dh: string; auth: string; userAgent?: string | null },
): Promise<PushSubscriptionRow> {
  const db = getDb();
  const existing = db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, data.endpoint))
    .get();
  if (existing) {
    await db
      .update(pushSubscriptions)
      .set({
        userId,
        p256dh: data.p256dh,
        auth: data.auth,
        userAgent: data.userAgent ?? existing.userAgent,
      })
      .where(eq(pushSubscriptions.id, existing.id));
    return (await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.id, existing.id))
      .get())!;
  }
  const id = newId();
  await db.insert(pushSubscriptions).values({
    id,
    userId,
    endpoint: data.endpoint,
    p256dh: data.p256dh,
    auth: data.auth,
    userAgent: data.userAgent ?? null,
  });
  return (await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, id)).get())!;
}

export async function deletePushSubscriptionByEndpoint(
  userId: string,
  endpoint: string,
): Promise<void> {
  const db = getDb();
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}

/** Prune path for dead subscriptions (push service returned 404/410). */
export async function deletePushSubscriptionById(id: string): Promise<void> {
  const db = getDb();
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
}

export async function markPushSubscriptionNotified(
  id: string,
  digest: string,
  notifiedAt: number,
): Promise<void> {
  const db = getDb();
  await db
    .update(pushSubscriptions)
    .set({ lastDigest: digest, lastNotifiedAt: notifiedAt })
    .where(eq(pushSubscriptions.id, id));
}
