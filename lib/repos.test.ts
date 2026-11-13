import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// repos.ts imports `./auth` which transitively pulls in next-auth → next/server,
// and Node's strict ESM resolution can't find the .js extension. Mocking the
// auth module to return a stub hashPassword keeps the import graph clean.
// We don't need real password hashing in repo tests — we feed users in via
// drizzle directly with a fake hash.
vi.mock("./auth", () => ({
  hashPassword: async (p: string) => `mock-hash-${p}`,
}));

import { __resetDbCacheForTests, getDb, runMigrations } from "./db/client";
import { users } from "./db/schema";
import { newId } from "./ids";
import {
  // settings
  getSettings,
  createBill,
  replaceDraftAllocations,
  listDraftAllocations,
  listBillLinkDescriptors,
  listBillPaymentOverridesForUser,
  upsertBillPaymentOverride,
  deleteBillPaymentOverride,
  listCreditCardPaymentOverridesForUser,
  upsertCreditCardPaymentOverride,
  deleteCreditCardPaymentOverride,
  // credit cards
  createCreditCard,
  createPromo,
  createPromoForDraft,
  approveDraftAsExpense,
  dismissPendingDraft,
  applyPromoReconcile,
  applyPaycheckPlan,
  archivePaychecks,
  createPaycheck,
  listPaychecks,
  listExtras,
  // Aliased: another open PR imports getPlaidDraft here too.
  getPlaidDraft as readDraft,
  getCreditCard,
  listCreditCards,
  listPromos,
  archivePromo,
  getNetWorthComponents,
  // plaid items / accounts
  createPlaidItem,
  upsertPlaidAccount,
  listPlaidAccountsByItem,
  deactivatePlaidItem,
  // plaid drafts
  upsertPlaidDraft,
  listPlaidDrafts,
  updatePlaidDraftStatus,
  getPrimaryLinkedBalance,
  getLinkedBalanceSnapshot,
  getPendingDraftOutflow,
  listPlaidItems,
  getPlaidDraft,
  updatePlaidAccount,
  // new (under test)
  setCreditCardPlaidLink,
  getCreditCardByPlaidAccountId,
  updateCardCycleDays,
  upsertCreditCardStatementByDate,
  listStatements,
  updateStatement,
  createStatement,
  settleStatementWithDraft,
  getPromo,
  // push subscriptions
  upsertPushSubscription,
  listPushSubscriptions,
  deletePushSubscriptionByEndpoint,
  deletePushSubscriptionById,
  markPushSubscriptionNotified,
  listAllPushSubscriptions,
  // users (session revocation)
  updateUserPassword,
  updateUserProfile,
  deleteUser,
} from "./repos";

// ── per-test SQLite fixture ────────────────────────────────────────────────
// Each test gets its own file in the OS tmp dir, opened fresh, migrated, then
// torn down. We avoid `:memory:` because better-sqlite3 in-memory DBs share no
// state across handles and we want the Drizzle migrator to actually run.
let dbDir: string;

beforeEach(() => {
  __resetDbCacheForTests();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-repos-"));
  process.env.DATABASE_URL = `file:${path.join(dbDir, "test.db")}`;
  // Touch a getDb() to initialize the singleton, then run migrations.
  getDb();
  runMigrations();
});

afterEach(() => {
  __resetDbCacheForTests();
  try {
    fs.rmSync(dbDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// Convenience: every test needs a user. We bypass createMember (which would
// call hashPassword) and insert directly via drizzle — repo tests don't care
// about hash quality, just that a user row exists.
async function makeUser(email = "test@example.com"): Promise<{ id: string }> {
  const db = getDb();
  const id = newId();
  await db
    .insert(users)
    .values({
      id,
      email,
      passwordHash: "x".repeat(64),
      displayName: "Tester",
      role: "admin",
    })
    .run();
  return { id };
}

// ────────────────────────────────────────────────────────────────────────────
// Foundation: migrations applied, can read empty settings
// ────────────────────────────────────────────────────────────────────────────
describe("repos / foundation", () => {
  it("migrations bring the schema online and an empty settings query returns null", async () => {
    const user = await makeUser();
    expect(user.id).toBeTruthy();
    const settings = await getSettings(user.id);
    // Settings rows are created on demand by createMember; if missing this returns undefined.
    expect(settings).toBeUndefined();
  });

  it("createCreditCard round-trips and listCreditCards filters by isActive", async () => {
    const user = await makeUser();
    const a = await createCreditCard(user.id, {
      name: "Active",
      statementDay: 5,
      dueDay: 25,
      autoPay: false,
      isActive: true,
    });
    await createCreditCard(user.id, {
      name: "Archived",
      statementDay: 5,
      dueDay: 25,
      autoPay: false,
      isActive: false,
    });
    const onlyActive = await listCreditCards(user.id, false);
    expect(onlyActive.map((c) => c.name)).toEqual(["Active"]);
    const all = await listCreditCards(user.id, true);
    expect(all.map((c) => c.name).sort()).toEqual(["Active", "Archived"]);
    expect((await getCreditCard(user.id, a.id))?.name).toBe("Active");
  });

  it("upserts and deletes a per-occurrence bill payment override", async () => {
    const user = await makeUser();
    const bill = await createBill(user.id, {
      name: "Rent",
      category: "Housing",
      amountCents: 1200_00,
      intervalMonths: 1,
      anchorDate: "2026-05-01",
      autoPay: false,
      paidViaCardId: null,
      notes: null,
      isActive: true,
    });

    await upsertBillPaymentOverride(user.id, bill.id, {
      dueDate: "2026-05-01",
      amountCents: 800_00,
      notes: null,
    });
    await upsertBillPaymentOverride(user.id, bill.id, {
      dueDate: "2026-05-01",
      amountCents: 500_00,
      notes: "split across paychecks",
    });

    const overrides = await listBillPaymentOverridesForUser(user.id);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({
      billId: bill.id,
      dueDate: "2026-05-01",
      amountCents: 500_00,
      notes: "split across paychecks",
    });

    await deleteBillPaymentOverride(user.id, bill.id, "2026-05-01");
    expect(await listBillPaymentOverridesForUser(user.id)).toEqual([]);
  });

  it("upserts and deletes a per-cycle credit card payment override", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Linked Card",
      statementDay: 3,
      dueDay: 24,
      autoPay: false,
      isActive: true,
    });

    await upsertCreditCardPaymentOverride(user.id, card.id, {
      dueDate: "2026-06-24",
      amountCents: 300_00,
      notes: null,
    });
    await upsertCreditCardPaymentOverride(user.id, card.id, {
      dueDate: "2026-06-24",
      amountCents: 125_00,
      notes: "partial payment",
    });

    const overrides = await listCreditCardPaymentOverridesForUser(user.id);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({
      cardId: card.id,
      dueDate: "2026-06-24",
      amountCents: 125_00,
      notes: "partial payment",
    });

    await deleteCreditCardPaymentOverride(user.id, card.id, "2026-06-24");
    expect(await listCreditCardPaymentOverridesForUser(user.id)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// setCreditCardPlaidLink — ownership + uniqueness
// ────────────────────────────────────────────────────────────────────────────
describe("repos / setCreditCardPlaidLink", () => {
  async function seedItemAndAccount(userId: string, accountId = "acct_xyz") {
    const item = await createPlaidItem(userId, {
      institutionId: "ins_test",
      institutionName: "Test Bank",
      accessTokenEnc: "00",
      accessTokenIv: "00",
      accessTokenTag: "00",
      cursor: null,
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: accountId,
      itemId: item.id,
      userId,
      name: "Test Credit",
      mask: "1234",
      type: "credit",
      subtype: "credit card",
      balanceCents: 50_00,
      updatedAt: Date.now(),
    });
    return { item, accountId };
  }

  it("links a card to a Plaid account and stores the link", async () => {
    const user = await makeUser();
    const { accountId } = await seedItemAndAccount(user.id);
    const card = await createCreditCard(user.id, {
      name: "Manual Card",
      statementDay: 1,
      dueDay: 21,
      autoPay: false,
      isActive: true,
    });
    const result = await setCreditCardPlaidLink(user.id, card.id, accountId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.card.plaidAccountId).toBe(accountId);
      expect(result.card.currentBalanceCents).toBe(50_00);
    }
    expect((await getCreditCardByPlaidAccountId(user.id, accountId))?.id).toBe(card.id);
  });

  it("clears the link when passed null", async () => {
    const user = await makeUser();
    const { accountId } = await seedItemAndAccount(user.id);
    const card = await createCreditCard(user.id, {
      name: "Card",
      statementDay: 1,
      dueDay: 21,
      autoPay: false,
      isActive: true,
      plaidAccountId: accountId,
    });
    const result = await setCreditCardPlaidLink(user.id, card.id, null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.card.plaidAccountId).toBeNull();
  });

  it("rejects linking when the Plaid account is owned by a different user", async () => {
    const userA = await makeUser("a@x.com");
    const userB = await makeUser("b@x.com");
    const { accountId } = await seedItemAndAccount(userA.id, "acct_owned_by_a");
    const card = await createCreditCard(userB.id, {
      name: "B's Card",
      statementDay: 1,
      dueDay: 21,
      autoPay: false,
      isActive: true,
    });
    const result = await setCreditCardPlaidLink(userB.id, card.id, accountId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/i);
  });

  it("rejects linking when another card already owns this Plaid account", async () => {
    const user = await makeUser();
    const { accountId } = await seedItemAndAccount(user.id);
    const cardA = await createCreditCard(user.id, {
      name: "First",
      statementDay: 1,
      dueDay: 21,
      autoPay: false,
      isActive: true,
      plaidAccountId: accountId,
    });
    const cardB = await createCreditCard(user.id, {
      name: "Second",
      statementDay: 1,
      dueDay: 21,
      autoPay: false,
      isActive: true,
    });
    const result = await setCreditCardPlaidLink(user.id, cardB.id, accountId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Already linked to "First"/);
    // cardA still owns the link
    expect((await getCreditCard(user.id, cardA.id))?.plaidAccountId).toBe(accountId);
  });

  it("returns Card not found when cardId does not belong to the user", async () => {
    const user = await makeUser();
    const { accountId } = await seedItemAndAccount(user.id);
    const result = await setCreditCardPlaidLink(user.id, "nonexistent", accountId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Card not found/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// upsertCreditCardStatementByDate — insert / update / paid-preservation
// ────────────────────────────────────────────────────────────────────────────
describe("repos / upsertCreditCardStatementByDate", () => {
  it("inserts a new statement when none exists for (cardId, statementDate)", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Card",
      statementDay: 15,
      dueDay: 5,
      autoPay: false,
      isActive: true,
    });
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2025-03-15",
      dueDate: "2025-04-05",
      statementBalanceCents: 200_00,
    });
    const stmts = await listStatements(card.id);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatchObject({
      statementDate: "2025-03-15",
      dueDate: "2025-04-05",
      statementBalanceCents: 200_00,
      minimumPaymentCents: null,
      paidAmountCents: null,
    });
  });

  it("re-running with identical (cardId, statementDate) updates in place — no dupe row", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Card",
      statementDay: 15,
      dueDay: 5,
      autoPay: false,
      isActive: true,
    });
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2025-03-15",
      dueDate: "2025-04-05",
      statementBalanceCents: 100_00,
    });
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2025-03-15",
      dueDate: "2025-04-10",
      statementBalanceCents: 250_00,
    });
    const stmts = await listStatements(card.id);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatchObject({
      dueDate: "2025-04-10",
      statementBalanceCents: 250_00,
    });
  });

  it("a hand-edited due date survives later Plaid upserts", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Card",
      statementDay: 15,
      dueDay: 5,
      autoPay: false,
      isActive: true,
    });
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2025-03-15",
      dueDate: "2025-04-05",
      statementBalanceCents: 100_00,
    });
    const created = (await listStatements(card.id))[0]!;
    // User corrects the due date by hand — the route sets the override flag.
    await updateStatement(created.id, { dueDate: "2025-04-12", dueDateUserOverride: true });

    // Next Plaid sync reports the old due date again — it must not win.
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2025-03-15",
      dueDate: "2025-04-05",
      statementBalanceCents: 100_00,
    });
    const stmts = await listStatements(card.id);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatchObject({ dueDate: "2025-04-12", statementBalanceCents: 100_00 });
  });

  it("updates the same due-date statement when Plaid shifts the statement date", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Card",
      statementDay: 10,
      dueDay: 7,
      autoPay: false,
      isActive: true,
    });
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2026-04-10",
      dueDate: "2026-05-07",
      statementBalanceCents: 653_13,
      paidAmountCents: 530_84,
      paidDate: "2026-04-20",
    });
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2026-04-19",
      dueDate: "2026-05-07",
      statementBalanceCents: 653_13,
      paidAmountCents: 530_84,
      paidDate: "2026-05-02",
    });

    const stmts = await listStatements(card.id);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatchObject({
      statementDate: "2026-04-19",
      dueDate: "2026-05-07",
      statementBalanceCents: 653_13,
      paidAmountCents: 530_84,
      paidDate: "2026-05-02",
    });
  });

  it("persists and updates the Plaid minimum payment on statement upsert", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "PayPal",
      statementDay: 15,
      dueDay: 5,
      autoPay: false,
      isActive: true,
    });
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2025-03-15",
      dueDate: "2025-04-05",
      statementBalanceCents: 0,
      minimumPaymentCents: 35_00,
    });
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2025-03-15",
      dueDate: "2025-04-05",
      statementBalanceCents: 0,
      minimumPaymentCents: 40_00,
    });

    const stmts = await listStatements(card.id);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatchObject({
      statementBalanceCents: 0,
      minimumPaymentCents: 40_00,
    });
  });

  it("preserves a manually-recorded paid status when Plaid returns no payment data", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Card",
      statementDay: 15,
      dueDay: 5,
      autoPay: false,
      isActive: true,
    });
    // Insert + manually mark paid.
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2025-03-15",
      dueDate: "2025-04-05",
      statementBalanceCents: 100_00,
      paidAmountCents: 100_00,
      paidDate: "2025-04-04",
    });
    // Re-sync from Plaid with NO payment data — should NOT clobber paid info.
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2025-03-15",
      dueDate: "2025-04-05",
      statementBalanceCents: 105_00, // late charge added
      paidAmountCents: null,
      paidDate: null,
    });
    const stmts = await listStatements(card.id);
    expect(stmts[0]).toMatchObject({
      paidAmountCents: 100_00,
      paidDate: "2025-04-04",
      statementBalanceCents: 105_00, // balance still updates
    });
  });

  it("overwrites paid info when Plaid DOES return new payment data (Plaid wins)", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Card",
      statementDay: 15,
      dueDay: 5,
      autoPay: false,
      isActive: true,
    });
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2025-03-15",
      dueDate: "2025-04-05",
      statementBalanceCents: 100_00,
      paidAmountCents: 100_00,
      paidDate: "2025-04-04",
    });
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2025-03-15",
      dueDate: "2025-04-05",
      statementBalanceCents: 100_00,
      paidAmountCents: 100_00,
      paidDate: "2025-04-03", // Plaid says different date
    });
    const stmts = await listStatements(card.id);
    expect(stmts[0]?.paidDate).toBe("2025-04-03");
  });

  it("ignores a Plaid $0 statement when a prior unpaid carryover and live balance exist", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "PayPal",
      statementDay: 15,
      dueDay: 5,
      autoPay: false,
      isActive: true,
    });
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2026-04-15",
      dueDate: "2026-05-05",
      statementBalanceCents: 275_00,
      paidAmountCents: 100_00,
      paidDate: "2026-05-01",
    });
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2026-05-15",
      dueDate: "2026-06-05",
      statementBalanceCents: 0,
      liveBalanceCents: 300_00,
    });

    const stmts = await listStatements(card.id);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatchObject({
      statementDate: "2026-04-15",
      statementBalanceCents: 275_00,
      paidAmountCents: 100_00,
    });
  });

  it("keeps a Plaid $0 statement when it has a minimum payment due", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "PayPal",
      statementDay: 15,
      dueDay: 5,
      autoPay: false,
      isActive: true,
    });
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2026-04-15",
      dueDate: "2026-05-05",
      statementBalanceCents: 275_00,
      paidAmountCents: 100_00,
      paidDate: "2026-05-01",
    });
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2026-05-15",
      dueDate: "2026-06-05",
      statementBalanceCents: 0,
      minimumPaymentCents: 35_00,
      liveBalanceCents: 300_00,
    });

    const stmts = await listStatements(card.id);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toMatchObject({
      statementDate: "2026-05-15",
      statementBalanceCents: 0,
      minimumPaymentCents: 35_00,
    });
  });
});

describe("repos / archivePromo", () => {
  it("zeroes remaining when a promo is manually archived", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Promo Card",
      statementDay: 15,
      dueDay: 5,
      autoPay: false,
      isActive: true,
    });
    const promo = await createPromo(user.id, card.id, {
      description: "Has balance",
      originalAmountCents: 500_00,
      remainingAmountCents: 420_00,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      monthlyPaymentCents: null,
      notes: null,
      isActive: true,
    });

    await archivePromo(user.id, promo.id);

    const promos = await listPromos(user.id, true);
    const archived = promos.find((p) => p.id === promo.id);
    expect(archived?.isActive).toBe(false);
    expect(archived?.remainingAmountCents).toBe(0);
  });
});

describe("repos / getNetWorthComponents", () => {
  it("does not count promo principal twice when it is embedded in a card balance", async () => {
    const user = await makeUser();
    const item = await createPlaidItem(user.id, {
      institutionId: "ins_paypal",
      institutionName: "PayPal",
      accessTokenEnc: "00",
      accessTokenIv: "00",
      accessTokenTag: "00",
      cursor: null,
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: "paypal_credit",
      itemId: item.id,
      userId: user.id,
      name: "PayPal Credit",
      mask: "1234",
      type: "credit",
      subtype: "paypal",
      balanceCents: 1_000_00,
      updatedAt: Date.now(),
    });
    const linkedBalanceCard = await createCreditCard(user.id, {
      name: "PayPal Credit",
      statementDay: 15,
      dueDay: 5,
      currentBalanceCents: 900_00,
      autoPay: false,
      isActive: true,
    });
    await setCreditCardPlaidLink(user.id, linkedBalanceCard.id, "paypal_credit");
    await createPromo(user.id, linkedBalanceCard.id, {
      description: "Deferred-interest purchase",
      originalAmountCents: 300_00,
      remainingAmountCents: 300_00,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      monthlyPaymentCents: null,
      notes: null,
      isActive: true,
    });

    const manualCard = await createCreditCard(user.id, {
      name: "Manual promo card",
      statementDay: 10,
      dueDay: 1,
      currentBalanceCents: null,
      autoPay: false,
      isActive: true,
    });
    await createPromo(user.id, manualCard.id, {
      description: "Manual deferred-interest purchase",
      originalAmountCents: 200_00,
      remainingAmountCents: 200_00,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      monthlyPaymentCents: null,
      notes: null,
      isActive: true,
    });

    const components = await getNetWorthComponents(user.id);
    expect(components.creditCardDebtCents).toBe(700_00);
    expect(components.promoDebtCents).toBe(500_00);
    expect(components.netWorthCents).toBe(-1_200_00);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// updateCardCycleDays — no-op when nothing changed
// ────────────────────────────────────────────────────────────────────────────
describe("repos / updateCardCycleDays", () => {
  it("updates statementDay/dueDay and bumps updatedAt", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Card",
      statementDay: 1,
      dueDay: 21,
      autoPay: false,
      isActive: true,
    });
    const beforeUpdated = (await getCreditCard(user.id, card.id))!.updatedAt;
    // Sleep 5ms so updatedAt is observable.
    await new Promise((r) => setTimeout(r, 5));
    await updateCardCycleDays(card.id, 15, 5);
    const after = await getCreditCard(user.id, card.id);
    expect(after?.statementDay).toBe(15);
    expect(after?.dueDay).toBe(5);
    expect(after!.updatedAt).toBeGreaterThan(beforeUpdated);
  });

  it("is a no-op when both values are unchanged (no bump to updatedAt)", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Card",
      statementDay: 15,
      dueDay: 5,
      autoPay: false,
      isActive: true,
    });
    const beforeUpdated = (await getCreditCard(user.id, card.id))!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await updateCardCycleDays(card.id, 15, 5);
    const after = await getCreditCard(user.id, card.id);
    expect(after!.updatedAt).toBe(beforeUpdated);
  });

  it("silently no-ops when the card does not exist", async () => {
    await expect(updateCardCycleDays("nonexistent", 15, 5)).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// deactivatePlaidItem — cascade null on linked credit_cards
// ────────────────────────────────────────────────────────────────────────────
describe("repos / deactivatePlaidItem", () => {
  it("nulls plaidAccountId on every credit_card linked to one of the item's accounts", async () => {
    const user = await makeUser();
    const item = await createPlaidItem(user.id, {
      institutionId: "ins_test",
      institutionName: "Test Bank",
      accessTokenEnc: "00",
      accessTokenIv: "00",
      accessTokenTag: "00",
      cursor: null,
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: "acct_a",
      itemId: item.id,
      userId: user.id,
      name: "A",
      mask: null,
      type: "credit",
      subtype: "credit card",
      balanceCents: 0,
      updatedAt: Date.now(),
    });
    await upsertPlaidAccount({
      id: "acct_b",
      itemId: item.id,
      userId: user.id,
      name: "B",
      mask: null,
      type: "credit",
      subtype: "credit card",
      balanceCents: 0,
      updatedAt: Date.now(),
    });
    const cardA = await createCreditCard(user.id, {
      name: "Card A", statementDay: 1, dueDay: 21, autoPay: false, isActive: true,
      plaidAccountId: "acct_a",
    });
    const cardB = await createCreditCard(user.id, {
      name: "Card B", statementDay: 1, dueDay: 21, autoPay: false, isActive: true,
      plaidAccountId: "acct_b",
    });
    const cardUnrelated = await createCreditCard(user.id, {
      name: "Manual Only", statementDay: 1, dueDay: 21, autoPay: false, isActive: true,
    });

    await deactivatePlaidItem(user.id, item.id);

    expect((await getCreditCard(user.id, cardA.id))?.plaidAccountId).toBeNull();
    expect((await getCreditCard(user.id, cardB.id))?.plaidAccountId).toBeNull();
    expect((await getCreditCard(user.id, cardUnrelated.id))?.plaidAccountId).toBeNull();
    // The cards themselves still exist (manual mode now).
    expect(await getCreditCard(user.id, cardA.id)).toBeTruthy();
  });

  it("does not touch cards belonging to a different user", async () => {
    const userA = await makeUser("a@x.com");
    const userB = await makeUser("b@x.com");
    const item = await createPlaidItem(userA.id, {
      institutionId: "ins_test",
      institutionName: "Test Bank",
      accessTokenEnc: "00",
      accessTokenIv: "00",
      accessTokenTag: "00",
      cursor: null,
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: "acct_a", itemId: item.id, userId: userA.id, name: "A",
      mask: null, type: "credit", subtype: null, balanceCents: 0, updatedAt: Date.now(),
    });
    // userB shouldn't be able to deactivate userA's item, but if they tried,
    // we want to be sure no card cleanup leaks across user boundaries.
    const cardB = await createCreditCard(userB.id, {
      name: "B's card", statementDay: 1, dueDay: 21, autoPay: false, isActive: true,
      plaidAccountId: "some_other_acct", // unrelated link, should never be touched
    });
    await deactivatePlaidItem(userA.id, item.id);
    expect((await getCreditCard(userB.id, cardB.id))?.plaidAccountId).toBe("some_other_acct");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Removed bank connections (review 2026-09-24 C01). A removed item's accounts
// keep their last balance forever; before the fix they still anchored the
// projection, held their pending cash forever, and a re-link of the same bank
// (which gets new account ids) roughly doubled the starting balance.
// ────────────────────────────────────────────────────────────────────────────
describe("repos / removed Plaid items stop feeding balances", () => {
  async function linkChecking(userId: string, accountId: string, balanceCents: number) {
    const item = await createPlaidItem(userId, {
      institutionId: "ins_bank", institutionName: "Bank",
      accessTokenEnc: "00", accessTokenIv: "00", accessTokenTag: "00",
      cursor: null, lastSyncedAt: null, isActive: true,
    });
    await upsertPlaidAccount({
      id: accountId, itemId: item.id, userId, name: "Checking",
      mask: "0001", type: "depository", subtype: "checking",
      balanceCents, availableBalanceCents: balanceCents, updatedAt: Date.now(),
    });
    await updatePlaidAccount(userId, accountId, { useAsStartingBalance: true });
    return item.id;
  }

  async function pendingDebit(userId: string, accountId: string, id: string, amountCents: number) {
    await upsertPlaidDraft({
      id, userId, accountId, date: "2026-09-20",
      description: "Pending card swipe", amountCents,
      plaidCategory: "GENERAL_MERCHANDISE", merchantName: null, pending: true,
      status: "approved", linkedExpenseId: null,
    });
  }

  it("a removed bank no longer anchors the starting balance", async () => {
    const user = await makeUser();
    const itemId = await linkChecking(user.id, "old_checking", 1_000_00);
    expect((await getLinkedBalanceSnapshot(user.id))?.balanceCents).toBe(1_000_00);

    await deactivatePlaidItem(user.id, itemId);

    expect(await listPlaidItems(user.id)).toHaveLength(0);
    expect(await getLinkedBalanceSnapshot(user.id)).toBeNull();
    expect(await getPrimaryLinkedBalance(user.id)).toBeNull();
  });

  it("re-linking the same bank counts only the new account, not old + new", async () => {
    const user = await makeUser();
    const oldItem = await linkChecking(user.id, "old_checking", 1_000_00);
    await deactivatePlaidItem(user.id, oldItem);
    // Plaid issues fresh account ids for a new Item.
    await linkChecking(user.id, "new_checking", 1_050_00);

    expect((await getLinkedBalanceSnapshot(user.id))?.balanceCents).toBe(1_050_00);
  });

  it("a removed bank's pending debits stop holding cash", async () => {
    const user = await makeUser();
    const itemId = await linkChecking(user.id, "old_checking", 1_000_00);
    await pendingDebit(user.id, "old_checking", "txn_pending", 40_00);
    expect(await getPendingDraftOutflow(user.id)).toBe(40_00);

    await deactivatePlaidItem(user.id, itemId);

    expect(await getPendingDraftOutflow(user.id)).toBe(0);
    // listPlaidDrafts hides removed items' rows, so read the row directly.
    expect((await getPlaidDraft(user.id, "txn_pending"))?.status).toBe("dismissed");
  });

  it("removal clears the account flag and keeps posted history", async () => {
    const user = await makeUser();
    const itemId = await linkChecking(user.id, "old_checking", 1_000_00);
    await upsertPlaidDraft({
      id: "txn_posted", userId: user.id, accountId: "old_checking", date: "2026-09-19",
      description: "Grocery", amountCents: 25_00,
      plaidCategory: "FOOD_AND_DRINK", merchantName: null, pending: false,
      status: "approved", linkedExpenseId: null,
    });

    await deactivatePlaidItem(user.id, itemId);

    const [account] = await listPlaidAccountsByItem(itemId);
    expect(account?.useAsStartingBalance).toBe(false);
    expect((await getPlaidDraft(user.id, "txn_posted"))?.status).toBe("approved");
  });

  it("a removed bank's balance is left out of net worth", async () => {
    const user = await makeUser();
    const itemId = await linkChecking(user.id, "old_checking", 1_000_00);
    expect((await getNetWorthComponents(user.id)).depositoryBalanceCents).toBe(1_000_00);

    await deactivatePlaidItem(user.id, itemId);

    expect((await getNetWorthComponents(user.id)).depositoryBalanceCents).toBe(0);
  });

  it("does nothing when the item belongs to another user", async () => {
    const owner = await makeUser("owner@x.com");
    const other = await makeUser("other@x.com");
    const itemId = await linkChecking(owner.id, "owner_checking", 1_000_00);
    await pendingDebit(owner.id, "owner_checking", "txn_owner", 10_00);

    await deactivatePlaidItem(other.id, itemId);

    expect(await listPlaidItems(owner.id)).toHaveLength(1);
    expect((await getLinkedBalanceSnapshot(owner.id))?.balanceCents).toBe(1_000_00);
    expect(await getPendingDraftOutflow(owner.id)).toBe(10_00);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// draft allocations — one transaction, several obligations
// ────────────────────────────────────────────────────────────────────────────
describe("repos / draft allocations", () => {
  async function seedSplittableDraft(email: string, draftId: string) {
    const user = await makeUser(email);
    const bill = await createBill(user.id, {
      name: "Wife",
      category: "Housing",
      amountCents: 2000_00,
      intervalMonths: 1,
      anchorDate: "2026-07-01",
      autoPay: false,
      paidViaCardId: null,
      notes: null,
      isActive: true,
    });
    const item = await createPlaidItem(user.id, {
      institutionId: "ins",
      institutionName: "T",
      accessTokenEnc: "00",
      accessTokenIv: "00",
      accessTokenTag: "00",
      cursor: null,
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: `acct-${draftId}`,
      itemId: item.id,
      userId: user.id,
      name: "Checking",
      mask: "1",
      type: "depository",
      subtype: "checking",
      balanceCents: 100_00,
      updatedAt: Date.now(),
    });
    await upsertPlaidDraft({
      id: draftId,
      userId: user.id,
      accountId: `acct-${draftId}`,
      date: "2026-06-27",
      description: "ACH ORIG DEBIT Lisette Izada",
      originalDescription: null,
      amountCents: 4000_00,
      plaidCategory: null,
      merchantName: null,
      pending: false,
      status: "approved",
      kind: "expense",
      linkedExpenseId: null,
      linkedPromoId: null,
    });
    return { user, billId: bill!.id };
  }

  it("learns the wording from a SPLIT, not just a whole-transaction link", async () => {
    // Pointing a transaction at a bill is how the app learns the bank's
    // wording. A user who splits a $4,000 transfer has named the bill just as
    // explicitly as one who linked it, and must get the same automatic
    // matching next month — otherwise splitting silently costs them the alias.
    const { user, billId } = await seedSplittableDraft("split-alias@example.com", "txn-split");

    expect(await listBillLinkDescriptors(user.id)).toEqual([]);

    await replaceDraftAllocations(user.id, "txn-split", [
      { targetKind: "bill", targetId: billId, targetDate: "2026-07-01", amountCents: 2000_00 },
    ]);

    expect(await listBillLinkDescriptors(user.id)).toEqual([
      { billId, description: "ACH ORIG DEBIT Lisette Izada", merchantName: null },
    ]);
  });

  it("replaces the whole split rather than merging into it", async () => {
    // A split is one statement about one transaction; merging would leave a
    // stale target still claiming money.
    const { user, billId } = await seedSplittableDraft("split-replace@example.com", "txn-replace");

    await replaceDraftAllocations(user.id, "txn-replace", [
      { targetKind: "bill", targetId: billId, targetDate: "2026-07-01", amountCents: 2000_00 },
      { targetKind: "extra", targetId: "extra-1", targetDate: "2026-07-01", amountCents: 2000_00 },
    ]);
    expect(await listDraftAllocations(user.id, "txn-replace")).toHaveLength(2);

    await replaceDraftAllocations(user.id, "txn-replace", [
      { targetKind: "bill", targetId: billId, targetDate: "2026-07-01", amountCents: 4000_00 },
    ]);
    const after = await listDraftAllocations(user.id, "txn-replace");
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ targetKind: "bill", amountCents: 4000_00 });

    // Clearing returns the transaction to automatic matching.
    await replaceDraftAllocations(user.id, "txn-replace", []);
    expect(await listDraftAllocations(user.id, "txn-replace")).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// getPrimaryLinkedBalance — opt-in starting-balance source
// ────────────────────────────────────────────────────────────────────────────
describe("repos / getPrimaryLinkedBalance", () => {
  async function seedAccount(userId: string, opts: { useAsStartingBalance: boolean; balanceCents: number | null; id?: string }) {
    const item = await createPlaidItem(userId, {
      institutionId: "ins", institutionName: "T",
      accessTokenEnc: "00", accessTokenIv: "00", accessTokenTag: "00",
      cursor: null, lastSyncedAt: null, isActive: true,
    });
    const id = opts.id ?? "acct_" + Math.random().toString(36).slice(2);
    await upsertPlaidAccount({
      id, itemId: item.id, userId, name: "Checking",
      mask: "0001", type: "depository", subtype: "checking",
      balanceCents: opts.balanceCents, updatedAt: Date.now(),
    });
    if (opts.useAsStartingBalance) {
      await updatePlaidAccount(userId, id, { useAsStartingBalance: true });
    }
    return id;
  }

  it("returns null when no account is opted in", async () => {
    const user = await makeUser();
    await seedAccount(user.id, { useAsStartingBalance: false, balanceCents: 100_00 });
    expect(await getPrimaryLinkedBalance(user.id)).toBeNull();
  });

  it("returns the live balance of the opted-in account", async () => {
    const user = await makeUser();
    await seedAccount(user.id, { useAsStartingBalance: true, balanceCents: 250_00 });
    expect(await getPrimaryLinkedBalance(user.id)).toBe(250_00);
  });

  it("sums balances when multiple accounts are opted in", async () => {
    // Households commonly mark both checking + savings as their starting
    // balance. The previous implementation silently picked the first row;
    // the fix sums everything.
    const user = await makeUser();
    await seedAccount(user.id, { useAsStartingBalance: true, balanceCents: 250_00, id: "checking" });
    await seedAccount(user.id, { useAsStartingBalance: true, balanceCents: 750_00, id: "savings" });
    expect(await getPrimaryLinkedBalance(user.id)).toBe(1000_00);
  });

  it("treats a null balance from an opted-in account as zero (not as 'no override')", async () => {
    const user = await makeUser();
    await seedAccount(user.id, { useAsStartingBalance: true, balanceCents: null, id: "pending" });
    await seedAccount(user.id, { useAsStartingBalance: true, balanceCents: 100_00, id: "real" });
    expect(await getPrimaryLinkedBalance(user.id)).toBe(100_00);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Plaid drafts — list / status filter / approve flow
// ────────────────────────────────────────────────────────────────────────────
describe("repos / plaid drafts", () => {
  async function setup() {
    const user = await makeUser();
    const item = await createPlaidItem(user.id, {
      institutionId: "ins", institutionName: "T",
      accessTokenEnc: "00", accessTokenIv: "00", accessTokenTag: "00",
      cursor: null, lastSyncedAt: null, isActive: true,
    });
    await upsertPlaidAccount({
      id: "acct", itemId: item.id, userId: user.id, name: "Checking",
      mask: "0001", type: "depository", subtype: "checking",
      balanceCents: 100_00, updatedAt: Date.now(),
    });
    return { userId: user.id, itemId: item.id, accountId: "acct" };
  }

  it("upsertPlaidDraft is idempotent on the same transaction_id", async () => {
    const { userId, accountId } = await setup();
    await upsertPlaidDraft({
      id: "txn_1", userId, accountId, date: "2025-04-01",
      description: "Coffee", amountCents: 5_50,
      plaidCategory: "FOOD", merchantName: "Cafe", pending: false,
      status: "pending_review", linkedExpenseId: null,
    });
    await upsertPlaidDraft({
      id: "txn_1", userId, accountId, date: "2025-04-01",
      description: "Coffee Inc.", amountCents: 6_00,
      plaidCategory: "FOOD", merchantName: "Cafe", pending: false,
      status: "pending_review", linkedExpenseId: null,
    });
    const drafts = await listPlaidDrafts(userId, "pending_review");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.amountCents).toBe(6_00);
    expect(drafts[0]?.description).toBe("Coffee Inc.");
  });

  it("listPlaidDrafts filters by status", async () => {
    const { userId, accountId } = await setup();
    await upsertPlaidDraft({
      id: "p", userId, accountId, date: "2025-04-01",
      description: "Pending", amountCents: 100,
      plaidCategory: null, merchantName: null, pending: false,
      status: "pending_review", linkedExpenseId: null,
    });
    await upsertPlaidDraft({
      id: "a", userId, accountId, date: "2025-04-02",
      description: "Approved", amountCents: 200,
      plaidCategory: null, merchantName: null, pending: false,
      status: "pending_review", linkedExpenseId: null,
    });
    await updatePlaidDraftStatus(userId, "a", { status: "approved", linkedExpenseId: "exp_1" });

    expect((await listPlaidDrafts(userId, "pending_review")).map((d) => d.id)).toEqual(["p"]);
    expect((await listPlaidDrafts(userId, "approved")).map((d) => d.id)).toEqual(["a"]);
    expect((await listPlaidDrafts(userId, "all")).map((d) => d.id).sort()).toEqual(["a", "p"]);
  });

  it("listPlaidDrafts excludes drafts from inactive Plaid items", async () => {
    const { userId, accountId } = await setup();
    const inactiveItem = await createPlaidItem(userId, {
      institutionId: "ins_old", institutionName: "Old",
      accessTokenEnc: "00", accessTokenIv: "00", accessTokenTag: "00",
      cursor: null, lastSyncedAt: null, isActive: false,
    });
    await upsertPlaidAccount({
      id: "acct_old", itemId: inactiveItem.id, userId, name: "Old Checking",
      mask: "9999", type: "depository", subtype: "checking",
      balanceCents: 0, updatedAt: Date.now(),
    });

    await upsertPlaidDraft({
      id: "active", userId, accountId, date: "2025-04-02",
      description: "Active", amountCents: 200,
      plaidCategory: null, merchantName: null, pending: false,
      status: "approved", linkedExpenseId: null,
    });
    await upsertPlaidDraft({
      id: "inactive", userId, accountId: "acct_old", date: "2025-04-03",
      description: "Inactive", amountCents: 300,
      plaidCategory: null, merchantName: null, pending: false,
      status: "approved", linkedExpenseId: null,
    });

    expect((await listPlaidDrafts(userId, "approved")).map((d) => d.id)).toEqual(["active"]);
    expect((await listPlaidDrafts(userId, "all")).map((d) => d.id)).toEqual(["active"]);
  });

  it("can link an approved Plaid draft to a promo", async () => {
    const { userId, accountId } = await setup();
    await upsertPlaidDraft({
      id: "promo_txn", userId, accountId, date: "2026-05-04",
      description: "Promo purchase", amountCents: 200_00,
      plaidCategory: null, merchantName: "PayPal", pending: false,
      status: "pending_review", linkedExpenseId: null, linkedPromoId: null,
    });

    const updated = await updatePlaidDraftStatus(userId, "promo_txn", {
      status: "approved",
      linkedPromoId: "promo_1",
    });

    expect(updated).toMatchObject({
      id: "promo_txn",
      status: "approved",
      linkedPromoId: "promo_1",
      linkedExpenseId: null,
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// listPlaidAccountsByItem — round-trip
// ────────────────────────────────────────────────────────────────────────────
describe("repos / listPlaidAccountsByItem", () => {
  it("returns only the accounts attached to the given item", async () => {
    const user = await makeUser();
    const itemA = await createPlaidItem(user.id, {
      institutionId: "ins_a", institutionName: "A",
      accessTokenEnc: "00", accessTokenIv: "00", accessTokenTag: "00",
      cursor: null, lastSyncedAt: null, isActive: true,
    });
    const itemB = await createPlaidItem(user.id, {
      institutionId: "ins_b", institutionName: "B",
      accessTokenEnc: "00", accessTokenIv: "00", accessTokenTag: "00",
      cursor: null, lastSyncedAt: null, isActive: true,
    });
    await upsertPlaidAccount({
      id: "a1", itemId: itemA.id, userId: user.id, name: "A1",
      mask: null, type: "depository", subtype: null, balanceCents: 0, updatedAt: Date.now(),
    });
    await upsertPlaidAccount({
      id: "b1", itemId: itemB.id, userId: user.id, name: "B1",
      mask: null, type: "depository", subtype: null, balanceCents: 0, updatedAt: Date.now(),
    });
    const aList = await listPlaidAccountsByItem(itemA.id);
    expect(aList.map((a) => a.id)).toEqual(["a1"]);
    const bList = await listPlaidAccountsByItem(itemB.id);
    expect(bList.map((a) => a.id)).toEqual(["b1"]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Statement paid transitions never infer promotional allocation
// ────────────────────────────────────────────────────────────────────────────
describe("repos / statement paid transitions", () => {
  it("statement payment updates never mutate issuer-tracked promo balances", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Card",
      statementDay: 10,
      dueDay: 5,
      autoPay: false,
      isActive: true,
    });

    // Insert already-paid: history, not an observed transition.
    const inserted = await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2026-01-10",
      dueDate: "2026-02-05",
      statementBalanceCents: 100_00,
      paidAmountCents: 100_00,
      paidDate: "2026-02-01",
    });
    expect(inserted).toEqual({ changed: true });

    // Insert unpaid, then update to paid: the edge fires exactly once.
    await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2026-02-10",
      dueDate: "2026-03-05",
      statementBalanceCents: 200_00,
    });
    const promo = await createPromo(user.id, card.id, {
      description: "Issuer-tracked promo",
      originalAmountCents: 600_00,
      remainingAmountCents: 600_00,
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      monthlyPaymentCents: null,
      notes: null,
      isActive: true,
    });
    const paidNow = await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2026-02-10",
      dueDate: "2026-03-05",
      statementBalanceCents: 200_00,
      paidAmountCents: 200_00,
      paidDate: "2026-03-01",
    });
    expect(paidNow).toEqual({ changed: true });
    expect((await getPromo(user.id, promo.id))?.remainingAmountCents).toBe(600_00);

    const resave = await upsertCreditCardStatementByDate(card.id, {
      statementDate: "2026-02-10",
      dueDate: "2026-03-05",
      statementBalanceCents: 200_00,
      paidAmountCents: 200_00,
      paidDate: "2026-03-01",
    });
    expect(resave).toEqual({ changed: true });
  });

  // ── push subscriptions ─────────────────────────────────────────────────────

  it("push subscriptions: upsert is endpoint-idempotent, delete is user-scoped", async () => {
    const { id: userId } = await makeUser("push@example.com");
    const { id: otherId } = await makeUser("push-other@example.com");

    const created = await upsertPushSubscription(userId, {
      endpoint: "https://push.example/sub/1",
      p256dh: "key-a",
      auth: "auth-a",
      userAgent: "TestBrowser/1.0",
    });
    expect(created.userId).toBe(userId);

    // Re-subscribe from the same browser: same row, refreshed keys.
    const updated = await upsertPushSubscription(userId, {
      endpoint: "https://push.example/sub/1",
      p256dh: "key-b",
      auth: "auth-b",
    });
    expect(updated.id).toBe(created.id);
    expect(updated.p256dh).toBe("key-b");
    expect(updated.userAgent).toBe("TestBrowser/1.0"); // preserved when omitted

    expect(await listPushSubscriptions(userId)).toHaveLength(1);
    expect(await listPushSubscriptions(otherId)).toHaveLength(0);

    // Another user's delete for this endpoint is a no-op.
    await deletePushSubscriptionByEndpoint(otherId, "https://push.example/sub/1");
    expect(await listPushSubscriptions(userId)).toHaveLength(1);

    await markPushSubscriptionNotified(created.id, "digest-1", 1_800_000_000_000);
    const [marked] = await listPushSubscriptions(userId);
    expect(marked).toMatchObject({ lastDigest: "digest-1", lastNotifiedAt: 1_800_000_000_000 });

    await deletePushSubscriptionByEndpoint(userId, "https://push.example/sub/1");
    expect(await listPushSubscriptions(userId)).toHaveLength(0);
  });

  it("push subscriptions: another user enabling push on the same browser takes over the one row and resets its dedupe state", async () => {
    // AUTH-5: a shared device. User A enables push and is notified; later user
    // B enables push in the same browser profile, so the push service hands
    // out the same endpoint. The row must end up owned by B alone, and A's
    // digest / last-notified time must not suppress B's first alert.
    const { id: a } = await makeUser("push-a@example.com");
    const { id: b } = await makeUser("push-b@example.com");
    const endpoint = "https://push.example/sub/shared-tablet";

    const first = await upsertPushSubscription(a, { endpoint, p256dh: "key-a", auth: "auth-a" });
    await markPushSubscriptionNotified(first.id, "digest-of-a", 1_800_000_000_000);

    const taken = await upsertPushSubscription(b, { endpoint, p256dh: "key-b", auth: "auth-b" });

    expect(taken.userId).toBe(b);
    expect(taken).toMatchObject({ p256dh: "key-b", auth: "auth-b", lastDigest: null, lastNotifiedAt: null });
    expect(await listPushSubscriptions(a)).toHaveLength(0);
    expect((await listPushSubscriptions(b)).map((s) => s.endpoint)).toEqual([endpoint]);

    // The same user re-subscribing keeps the dedupe state (no re-nag).
    await markPushSubscriptionNotified(taken.id, "digest-of-b", 1_800_000_100_000);
    const again = await upsertPushSubscription(b, { endpoint, p256dh: "key-c", auth: "auth-c" });
    expect(again).toMatchObject({ lastDigest: "digest-of-b", lastNotifiedAt: 1_800_000_100_000 });
  });

  it("push subscriptions: a password or role change (session revocation) deletes that user's subscriptions only", async () => {
    // A sessionVersion bump ends the user's sessions on every device; the
    // devices must not keep receiving that user's card alerts afterwards.
    const { id: userId } = await makeUser("push-revoke@example.com");
    const { id: otherId } = await makeUser("push-revoke-other@example.com");
    const sub = (endpoint: string) => ({ endpoint, p256dh: "k", auth: "a" });

    await upsertPushSubscription(userId, sub("https://push.example/sub/r1"));
    await upsertPushSubscription(userId, sub("https://push.example/sub/r2"));
    await upsertPushSubscription(otherId, sub("https://push.example/sub/other"));

    await updateUserPassword(userId, "a-new-password");
    expect(await listPushSubscriptions(userId)).toHaveLength(0);
    expect(await listPushSubscriptions(otherId)).toHaveLength(1);

    // A display-name edit does not revoke sessions, so it keeps the devices.
    await upsertPushSubscription(userId, sub("https://push.example/sub/r3"));
    await updateUserProfile(userId, { displayName: "Renamed" });
    await updateUserProfile(userId, { role: "admin" }); // unchanged role: no bump
    expect(await listPushSubscriptions(userId)).toHaveLength(1);

    // A real role change revokes sessions and removes the devices.
    await updateUserProfile(userId, { role: "member" });
    expect(await listPushSubscriptions(userId)).toHaveLength(0);
    expect(await listPushSubscriptions(otherId)).toHaveLength(1);
  });

  it("push subscriptions: deleting a user cascades to their subscriptions", async () => {
    const { id: userId } = await makeUser("push-deleted@example.com");
    await upsertPushSubscription(userId, { endpoint: "https://push.example/sub/gone", p256dh: "k", auth: "a" });
    await deleteUser(userId);
    expect(await listAllPushSubscriptions()).toHaveLength(0);
  });

  it("push subscriptions: prune by id removes a dead subscription", async () => {
    const { id: userId } = await makeUser("push-prune@example.com");
    const sub = await upsertPushSubscription(userId, {
      endpoint: "https://push.example/sub/dead",
      p256dh: "k",
      auth: "a",
    });
    await deletePushSubscriptionById(sub.id);
    expect(await listPushSubscriptions(userId)).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// settleStatementWithDraft: a posted card payment goes to the statement of the
// cycle it pays (PAY-3). One card, two cycles with the same $15.99 balance.
// ────────────────────────────────────────────────────────────────────────────
describe("repos / settleStatementWithDraft picks the payment's own cycle", () => {
  async function seedTwoCycles(opts: { octPaid: boolean; novBalanceCents?: number }) {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Netflix Card",
      statementDay: 28,
      dueDay: 25,
      autoPay: false,
      isActive: true,
    });
    const oct = await createStatement(card.id, {
      statementDate: "2026-09-28",
      dueDate: "2026-10-25",
      statementBalanceCents: 15_99,
      paidAmountCents: opts.octPaid ? 15_99 : null,
      paidDate: opts.octPaid ? "2026-10-20" : null,
      notes: null,
    });
    const nov = await createStatement(card.id, {
      statementDate: "2026-10-28",
      dueDate: "2026-11-25",
      statementBalanceCents: opts.novBalanceCents ?? 15_99,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });
    const read = async () => {
      const stmts = await listStatements(card.id);
      return {
        oct: stmts.find((s) => s.id === oct.id)!,
        nov: stmts.find((s) => s.id === nov.id)!,
      };
    };
    return { user, card, read };
  }

  it("the November payment settles November, not the October statement paid by hand", async () => {
    const { user, card, read } = await seedTwoCycles({ octPaid: true });
    const settled = await settleStatementWithDraft(user.id, {
      draftId: "nov-payment",
      cardId: card.id,
      paymentCents: 15_99,
      date: "2026-11-20",
    });
    const { oct, nov } = await read();
    expect(settled?.dueDate).toBe("2026-11-25");
    expect(nov.paidAmountCents).toBe(15_99);
    expect(nov.paidDate).toBe("2026-11-20");
    expect(nov.settledByDraftId).toBe("nov-payment");
    expect(oct.paidAmountCents).toBe(15_99);
    expect(oct.paidDate).toBe("2026-10-20");
    expect(oct.settledByDraftId).toBeNull();
  });

  it("a payment before the October due date is October's: stamped there, November stays open", async () => {
    const { user, card, read } = await seedTwoCycles({ octPaid: true });
    const settled = await settleStatementWithDraft(user.id, {
      draftId: "oct-payment",
      cardId: card.id,
      paymentCents: 15_99,
      date: "2026-10-21",
    });
    const { oct, nov } = await read();
    expect(settled).toBeNull();
    expect(oct.settledByDraftId).toBe("oct-payment");
    expect(oct.paidAmountCents).toBe(15_99);
    expect(oct.paidDate).toBe("2026-10-20");
    expect(nov.paidAmountCents).toBeNull();
    expect(nov.settledByDraftId).toBeNull();
  });

  it("a late payment after the October due date but before November is issued is still October's", async () => {
    // November's balance did not exist yet on 10-27, so this payment cannot
    // be paying it.
    const { user, card, read } = await seedTwoCycles({ octPaid: true });
    const settled = await settleStatementWithDraft(user.id, {
      draftId: "late-oct-payment",
      cardId: card.id,
      paymentCents: 15_99,
      date: "2026-10-27",
    });
    const { oct, nov } = await read();
    expect(settled).toBeNull();
    expect(oct.settledByDraftId).toBe("late-oct-payment");
    expect(nov.paidAmountCents).toBeNull();
    expect(nov.settledByDraftId).toBeNull();
  });

  it("a payment on November's statement date still belongs to October (it posts in the closing cycle)", async () => {
    const { user, card, read } = await seedTwoCycles({ octPaid: true });
    await settleStatementWithDraft(user.id, {
      draftId: "closing-day-payment",
      cardId: card.id,
      paymentCents: 15_99,
      date: "2026-10-28",
    });
    const { oct, nov } = await read();
    expect(oct.settledByDraftId).toBe("closing-day-payment");
    expect(nov.paidAmountCents).toBeNull();
  });

  it("with two unpaid statements, a payment equal only to the older one settles the older one", async () => {
    const { user, card, read } = await seedTwoCycles({ octPaid: false, novBalanceCents: 42_00 });
    const settled = await settleStatementWithDraft(user.id, {
      draftId: "oct-late",
      cardId: card.id,
      paymentCents: 15_99,
      date: "2026-11-02",
    });
    const { oct, nov } = await read();
    expect(settled?.dueDate).toBe("2026-10-25");
    expect(oct.paidAmountCents).toBe(15_99);
    expect(oct.settledByDraftId).toBe("oct-late");
    expect(nov.paidAmountCents).toBeNull();
    expect(nov.settledByDraftId).toBeNull();
  });

  it("with two unpaid same-balance statements, a payment before November is issued settles October", async () => {
    const { user, card, read } = await seedTwoCycles({ octPaid: false });
    const settled = await settleStatementWithDraft(user.id, {
      draftId: "oct-late",
      cardId: card.id,
      paymentCents: 15_99,
      date: "2026-10-26",
    });
    const { oct, nov } = await read();
    expect(settled?.dueDate).toBe("2026-10-25");
    expect(oct.settledByDraftId).toBe("oct-late");
    expect(nov.paidAmountCents).toBeNull();
    expect(nov.settledByDraftId).toBeNull();
  });

  it("a payment that matches only a statement paid by hand is still consumed there (consume-once)", async () => {
    // November's balance differs, so no open statement matches $15.99: the
    // payment the user recorded by hand must be stamped, not left free to
    // settle something later.
    const { user, card, read } = await seedTwoCycles({ octPaid: true, novBalanceCents: 42_00 });
    const settled = await settleStatementWithDraft(user.id, {
      draftId: "oct-payment",
      cardId: card.id,
      paymentCents: 15_99,
      date: "2026-11-01",
    });
    const { oct, nov } = await read();
    expect(settled).toBeNull();
    expect(oct.settledByDraftId).toBe("oct-payment");
    expect(oct.paidAmountCents).toBe(15_99);
    expect(nov.paidAmountCents).toBeNull();
    expect(nov.settledByDraftId).toBeNull();
  });

  it("a second settle of the same draft is a no-op", async () => {
    const { user, card, read } = await seedTwoCycles({ octPaid: true });
    const input = { draftId: "nov-payment", cardId: card.id, paymentCents: 15_99, date: "2026-11-20" };
    expect(await settleStatementWithDraft(user.id, input)).not.toBeNull();
    const before = await read();
    expect(await settleStatementWithDraft(user.id, input)).toBeNull();
    const after = await read();
    expect(after).toEqual(before);
    expect(after.nov.settledByDraftId).toBe("nov-payment");
    expect(after.oct.settledByDraftId).toBeNull();
  });

  it("a prepayment dated before November's statement date that matches only November settles November (fallback)", async () => {
    // October's balance differs, so November is the only candidate and it was
    // issued AFTER the payment: the fallback takes the oldest such candidate.
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Prepay Card",
      statementDay: 28,
      dueDay: 25,
      autoPay: false,
      isActive: true,
    });
    const oct = await createStatement(card.id, {
      statementDate: "2026-09-28",
      dueDate: "2026-10-25",
      statementBalanceCents: 42_00,
      paidAmountCents: 42_00,
      paidDate: "2026-10-20",
      notes: null,
    });
    const nov = await createStatement(card.id, {
      statementDate: "2026-10-28",
      dueDate: "2026-11-25",
      statementBalanceCents: 15_99,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });
    const settled = await settleStatementWithDraft(user.id, {
      draftId: "prepay",
      cardId: card.id,
      paymentCents: 15_99,
      date: "2026-10-26",
    });
    const stmts = await listStatements(card.id);
    expect(settled?.id).toBe(nov.id);
    expect(stmts.find((s) => s.id === nov.id)?.settledByDraftId).toBe("prepay");
    expect(stmts.find((s) => s.id === nov.id)?.paidAmountCents).toBe(15_99);
    expect(stmts.find((s) => s.id === oct.id)?.settledByDraftId).toBeNull();
  });

  it("only the payment's own card is a candidate, even with identical statements on another card", async () => {
    const user = await makeUser();
    const mk = (name: string) =>
      createCreditCard(user.id, { name, statementDay: 28, dueDay: 25, autoPay: false, isActive: true });
    const cardA = await mk("Card A");
    const cardB = await mk("Card B");
    // Card B's statement is a hand-paid one with the same amount and dates:
    // a cross-card leak would stamp it instead of settling Card A.
    const stmtA = await createStatement(cardA.id, {
      statementDate: "2026-10-28",
      dueDate: "2026-11-25",
      statementBalanceCents: 15_99,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });
    const stmtB = await createStatement(cardB.id, {
      statementDate: "2026-10-28",
      dueDate: "2026-11-25",
      statementBalanceCents: 15_99,
      paidAmountCents: 15_99,
      paidDate: "2026-11-18",
      notes: null,
    });
    const settled = await settleStatementWithDraft(user.id, {
      draftId: "pay-a",
      cardId: cardA.id,
      paymentCents: 15_99,
      date: "2026-11-20",
    });
    expect(settled?.id).toBe(stmtA.id);
    expect((await listStatements(cardB.id))[0]).toEqual(stmtB);

    // The same draft can never be spent again, not even on the other card.
    expect(
      await settleStatementWithDraft(user.id, {
        draftId: "pay-a",
        cardId: cardB.id,
        paymentCents: 15_99,
        date: "2026-11-20",
      }),
    ).toBeNull();
    expect((await listStatements(cardB.id))[0]).toEqual(stmtB);
  });

  // B1: a manual card whose November statement date is an estimate (entered
  // 10-28, real close 11-03). October was recorded paid BY HAND on 10-30;
  // Plaid then posts that same payment. The row's own paid amount + date is
  // evidence about the same payment and beats the statement-date inference.
  async function seedEstimatedNov(octPaidDate: string | null) {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Manual Card",
      statementDay: 28,
      dueDay: 25,
      autoPay: false,
      isActive: true,
    });
    const oct = await createStatement(card.id, {
      statementDate: "2026-09-28",
      dueDate: "2026-10-25",
      statementBalanceCents: 15_99,
      paidAmountCents: 15_99,
      paidDate: octPaidDate,
      notes: null,
    });
    const nov = await createStatement(card.id, {
      statementDate: "2026-10-28",
      dueDate: "2026-11-25",
      statementBalanceCents: 15_99,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });
    const settle = (draftId: string, date: string) =>
      settleStatementWithDraft(user.id, { draftId, cardId: card.id, paymentCents: 15_99, date });
    const read = async () => {
      const stmts = await listStatements(card.id);
      return {
        oct: stmts.find((s) => s.id === oct.id)!,
        nov: stmts.find((s) => s.id === nov.id)!,
      };
    };
    return { settle, read };
  }

  for (const [label, date] of [
    ["the same day", "2026-10-30"],
    ["1 day after", "2026-10-31"],
    ["3 days after", "2026-11-02"],
    ["7 days after (the bound)", "2026-11-06"],
  ] as const) {
    it(`B1: the payment the user recorded by hand, posted ${label}, is stamped on October; November stays open`, async () => {
      const { settle, read } = await seedEstimatedNov("2026-10-30");
      expect(await settle("oct-posted", date)).toBeNull();
      const { oct, nov } = await read();
      expect(oct.settledByDraftId).toBe("oct-posted");
      expect(oct.paidAmountCents).toBe(15_99);
      expect(oct.paidDate).toBe("2026-10-30");
      expect(nov.paidAmountCents).toBeNull();
      expect(nov.paidDate).toBeNull();
      expect(nov.settledByDraftId).toBeNull();
    });
  }

  it("B1: 8 days after the recorded paidDate (bound + 1) is no longer the same payment; the cycle rule settles November", async () => {
    const { settle, read } = await seedEstimatedNov("2026-10-30");
    expect((await settle("later", "2026-11-07"))?.dueDate).toBe("2026-11-25");
    const { oct, nov } = await read();
    expect(nov.settledByDraftId).toBe("later");
    expect(nov.paidAmountCents).toBe(15_99);
    expect(oct.settledByDraftId).toBeNull();
  });

  it("B1: a hand-paid row with the right amount but a paidDate 31 days earlier does not capture the payment", async () => {
    const { settle, read } = await seedEstimatedNov("2026-10-20");
    expect((await settle("nov-payment", "2026-11-20"))?.dueDate).toBe("2026-11-25");
    const { oct, nov } = await read();
    expect(nov.settledByDraftId).toBe("nov-payment");
    expect(oct.settledByDraftId).toBeNull();
  });

  it("B1: a hand-paid row with a NULL paidDate falls through to the cycle rule", async () => {
    const { settle, read } = await seedEstimatedNov(null);
    expect((await settle("oct-posted", "2026-10-30"))?.dueDate).toBe("2026-11-25");
    const { oct, nov } = await read();
    expect(nov.settledByDraftId).toBe("oct-posted");
    expect(oct.settledByDraftId).toBeNull();
  });

  it("B1: two hand-paid rows with the same amount: the nearest recorded paidDate wins", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Two Hand-Paid",
      statementDay: 28,
      dueDay: 25,
      autoPay: false,
      isActive: true,
    });
    const sep = await createStatement(card.id, {
      statementDate: "2026-08-28",
      dueDate: "2026-09-25",
      statementBalanceCents: 15_99,
      paidAmountCents: 15_99,
      paidDate: "2026-10-01",
      notes: null,
    });
    const oct = await createStatement(card.id, {
      statementDate: "2026-09-28",
      dueDate: "2026-10-25",
      statementBalanceCents: 15_99,
      paidAmountCents: 15_99,
      paidDate: "2026-10-05",
      notes: null,
    });
    // Payment 10-02 is 1 day from Sep's paidDate and 3 from Oct's, so Sep
    // wins, although the cycle rule alone would pick Oct (issued 09-28).
    expect(
      await settleStatementWithDraft(user.id, {
        draftId: "posted",
        cardId: card.id,
        paymentCents: 15_99,
        date: "2026-10-02",
      }),
    ).toBeNull();
    const stmts = await listStatements(card.id);
    expect(stmts.find((s) => s.id === sep.id)?.settledByDraftId).toBe("posted");
    expect(stmts.find((s) => s.id === oct.id)?.settledByDraftId).toBeNull();
  });

  it("two racing passes with different drafts cannot overwrite each other's stamp on a hand-paid row", async () => {
    // Only a hand-paid row matches, so both drafts pick it. Started together,
    // both read the statements before either writes; the second write must
    // not replace the first stamp (that would free the first draft).
    const { user, card, read } = await seedTwoCycles({ octPaid: true, novBalanceCents: 42_00 });
    const settle = (draftId: string) =>
      settleStatementWithDraft(user.id, {
        draftId,
        cardId: card.id,
        paymentCents: 15_99,
        date: "2026-10-21",
      });
    const [first, second] = await Promise.all([settle("draft-1"), settle("draft-2")]);
    expect(first).toBeNull();
    expect(second).toBeNull();
    const { oct, nov } = await read();
    expect(oct.settledByDraftId).toBe("draft-1");
    expect(nov.settledByDraftId).toBeNull();

    // And sequentially: a later, different draft leaves the stamp alone.
    expect(await settle("draft-3")).toBeNull();
    expect((await read()).oct.settledByDraftId).toBe("draft-1");
  });

  it("(c) two open $15.99 statements: an 11-20 payment settles November, a second on 11-22 settles October", async () => {
    const { user, card, read } = await seedTwoCycles({ octPaid: false });
    const settle = (draftId: string, date: string) =>
      settleStatementWithDraft(user.id, { draftId, cardId: card.id, paymentCents: 15_99, date });
    expect((await settle("pay-1", "2026-11-20"))?.dueDate).toBe("2026-11-25");
    expect((await settle("pay-2", "2026-11-22"))?.dueDate).toBe("2026-10-25");
    const { oct, nov } = await read();
    expect(nov.settledByDraftId).toBe("pay-1");
    expect(nov.paidAmountCents).toBe(15_99);
    expect(oct.settledByDraftId).toBe("pay-2");
    expect(oct.paidAmountCents).toBe(15_99);
  });

  it("(g) an Interest Saving Balance payment settles November even when an older statement was hand-paid the same amount", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Flex Card",
      statementDay: 28,
      dueDay: 25,
      autoPay: false,
      isActive: true,
    });
    // ISB = 1,500 − 1,000 promo principal + 100 plan payment = 600.
    await createPromo(user.id, card.id, {
      description: "Equal Pay plan",
      originalAmountCents: 1_200_00,
      remainingAmountCents: 1_000_00,
      startDate: "2026-06-01",
      endDate: "2027-12-31",
      monthlyPaymentCents: 100_00,
      notes: null,
      isActive: true,
    });
    const oct = await createStatement(card.id, {
      statementDate: "2026-09-28",
      dueDate: "2026-10-25",
      statementBalanceCents: 1_500_00,
      paidAmountCents: 600_00,
      paidDate: "2026-10-20",
      notes: null,
    });
    const nov = await createStatement(card.id, {
      statementDate: "2026-10-28",
      dueDate: "2026-11-25",
      statementBalanceCents: 1_500_00,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });
    const settled = await settleStatementWithDraft(user.id, {
      draftId: "isb-nov",
      cardId: card.id,
      paymentCents: 600_00,
      date: "2026-11-20",
    });
    expect(settled?.id).toBe(nov.id);
    const stmts = await listStatements(card.id);
    expect(stmts.find((s) => s.id === nov.id)?.paidAmountCents).toBe(600_00);
    expect(stmts.find((s) => s.id === nov.id)?.settledByDraftId).toBe("isb-nov");
    expect(stmts.find((s) => s.id === oct.id)?.settledByDraftId).toBeNull();
  });

  it("N1 (known, unchanged from main): statementDate == dueDate, a payment on/just before the next due date stamps the hand-paid older row", async () => {
    // Manual card where each statement was entered with statementDate equal
    // to dueDate. The Oct row (10-25/10-25) is not "issued before" a payment
    // on 10-24 or 10-25, so the cycle rule picks Sep; Sep's paidDate is a
    // month away, so the same-payment rule does not apply either. Oct stays
    // open (overstated due, the safe direction).
    for (const date of ["2026-10-24", "2026-10-25"]) {
      const user = await makeUser(`n1-${date}@example.com`);
      const card = await createCreditCard(user.id, {
        name: "Same-Day Card",
        statementDay: 25,
        dueDay: 25,
        autoPay: false,
        isActive: true,
      });
      const sep = await createStatement(card.id, {
        statementDate: "2026-09-25",
        dueDate: "2026-09-25",
        statementBalanceCents: 15_99,
        paidAmountCents: 15_99,
        paidDate: "2026-09-24",
        notes: null,
      });
      const oct = await createStatement(card.id, {
        statementDate: "2026-10-25",
        dueDate: "2026-10-25",
        statementBalanceCents: 15_99,
        paidAmountCents: null,
        paidDate: null,
        notes: null,
      });
      expect(
        await settleStatementWithDraft(user.id, {
          draftId: `pay-${date}`,
          cardId: card.id,
          paymentCents: 15_99,
          date,
        }),
      ).toBeNull();
      const stmts = await listStatements(card.id);
      expect(stmts.find((s) => s.id === sep.id)?.settledByDraftId).toBe(`pay-${date}`);
      expect(stmts.find((s) => s.id === oct.id)?.paidAmountCents).toBeNull();
      expect(stmts.find((s) => s.id === oct.id)?.settledByDraftId).toBeNull();
    }
  });

  it("a true partial payment is left unmatched", async () => {
    const { user, card, read } = await seedTwoCycles({ octPaid: true });
    const settled = await settleStatementWithDraft(user.id, {
      draftId: "partial",
      cardId: card.id,
      paymentCents: 10_00,
      date: "2026-11-20",
    });
    const { oct, nov } = await read();
    expect(settled).toBeNull();
    expect(nov.paidAmountCents).toBeNull();
    expect(nov.settledByDraftId).toBeNull();
    expect(oct.settledByDraftId).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Atomic multi-step writes (review 2026-09-24 C11): all or nothing, and the
// "already actioned?" check is part of the write itself.
// ────────────────────────────────────────────────────────────────────────────
describe("repos / atomic multi-step writes", () => {
  async function setup() {
    const user = await makeUser();
    const item = await createPlaidItem(user.id, {
      institutionId: "ins", institutionName: "T",
      accessTokenEnc: "00", accessTokenIv: "00", accessTokenTag: "00",
      cursor: null, lastSyncedAt: null, isActive: true,
    });
    await upsertPlaidAccount({
      id: "acct_card", itemId: item.id, userId: user.id, name: "Card", mask: null,
      type: "credit", subtype: "credit card", balanceCents: 0, updatedAt: Date.now(),
    });
    const card = await createCreditCard(user.id, {
      name: "Card", statementDay: 1, dueDay: 21, autoPay: false, isActive: true, plaidAccountId: "acct_card",
    });
    await upsertPlaidDraft({
      id: "txn_1", userId: user.id, accountId: "acct_card", date: "2026-09-01",
      description: "Sofa", amountCents: 1_200_00, plaidCategory: "HOME", merchantName: "Sofa Co",
      pending: false, status: "pending_review", linkedExpenseId: null,
    });
    return { userId: user.id, cardId: card.id };
  }
  const promoData = {
    description: "Sofa", originalAmountCents: 1_200_00, remainingAmountCents: 1_200_00,
    startDate: "2026-09-01", endDate: "2027-09-01", monthlyPaymentCents: null, notes: null, isActive: true,
  };

  it("createPromoForDraft links once; a second call writes nothing", async () => {
    const { userId, cardId } = await setup();
    const first = createPromoForDraft(userId, cardId, "txn_1", promoData);
    const second = createPromoForDraft(userId, cardId, "txn_1", promoData);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await listPromos(userId, false)).toHaveLength(1);
    expect((await readDraft(userId, "txn_1"))?.linkedPromoId).toBe(first!.id);
  });

  it("approveDraftAsExpense creates one expense; a repeat or a dismissed draft gets null", async () => {
    const { userId } = await setup();
    const expense = { date: "2026-09-01", description: "Sofa", amountCents: 1_200_00, category: "Other", notes: null };
    expect(approveDraftAsExpense(userId, "txn_1", expense)).not.toBeNull();
    expect(approveDraftAsExpense(userId, "txn_1", expense)).toBeNull();
    expect(await listExtras(userId)).toHaveLength(1);
    expect(dismissPendingDraft(userId, "txn_1")).toBe(false);
    expect((await readDraft(userId, "txn_1"))?.status).toBe("approved");
  });

  it("applyPromoReconcile rolls every change back when one fails", async () => {
    const { userId, cardId } = await setup();
    const existing = await createPromo(userId, cardId, { ...promoData, description: "Old" });
    expect(() =>
      applyPromoReconcile(userId, cardId, {
        updates: [{ promoId: existing.id, patch: { remainingAmountCents: 1 } }],
        // endDate is NOT NULL: this insert fails after the update ran.
        creates: [{ ...promoData, endDate: null as unknown as string }],
        archiveIds: [],
      }),
    ).toThrow();
    const promos = await listPromos(userId, false);
    expect(promos).toHaveLength(1);
    expect(promos[0]?.remainingAmountCents).toBe(1_200_00);
  });

  it("applyPaycheckPlan rolls back a half-applied run", async () => {
    const user = await makeUser();
    const kept = await createPaycheck(user.id, { payDate: "2026-10-01", amountCents: 2_000_00, note: null });
    expect(() =>
      applyPaycheckPlan(
        user.id,
        [
          { action: "add", payDate: "2026-10-15", amountCents: 2_000_00 },
          { action: "move", id: kept.id, payDate: null as unknown as string, fromPayDate: "2026-10-01", amountCents: 2_000_00 },
        ],
        null,
      ),
    ).toThrow();
    const rows = await listPaychecks(user.id);
    expect(rows.map((p) => p.payDate)).toEqual(["2026-10-01"]);
  });
});

describe("repos / archivePaychecks", () => {
  it("archives only the caller's rows and releases their deposit drafts", async () => {
    const me = await makeUser("me@example.com");
    const other = await makeUser("other@example.com");
    const mine = await createPaycheck(me.id, {
      payDate: "2026-10-09",
      amountCents: 2_000_00,
      note: null,
      settledByDraftId: "draft-1",
    });
    const theirs = await createPaycheck(other.id, { payDate: "2026-10-09", amountCents: 1_00, note: null });

    expect(archivePaychecks(me.id, [mine.id, theirs.id])).toBe(1);

    expect(await listPaychecks(me.id)).toEqual([]);
    const [archived] = await listPaychecks(me.id, true);
    expect(archived).toMatchObject({ isActive: false, settledByDraftId: null });
    expect((await listPaychecks(other.id)).map((p) => p.id)).toEqual([theirs.id]);
  });

  it("keeps one-time income flagged through create", async () => {
    const me = await makeUser();
    const bonus = await createPaycheck(me.id, {
      payDate: "2026-12-15",
      amountCents: 2_500_00,
      note: "Year-end bonus",
      isOneTime: true,
    });
    expect(bonus.isOneTime).toBe(true);
  });
});
