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
  listBillPaymentOverridesForUser,
  upsertBillPaymentOverride,
  deleteBillPaymentOverride,
  listCreditCardPaymentOverridesForUser,
  upsertCreditCardPaymentOverride,
  deleteCreditCardPaymentOverride,
  // credit cards
  createCreditCard,
  createPromo,
  getCreditCard,
  listCreditCards,
  listPromos,
  archiveExpiredPromos,
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
  updatePlaidAccount,
  // new (under test)
  setCreditCardPlaidLink,
  getCreditCardByPlaidAccountId,
  updateCardCycleDays,
  upsertCreditCardStatementByDate,
  listStatements,
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
    if (result.ok) expect(result.card.plaidAccountId).toBe(accountId);
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

describe("repos / archiveExpiredPromos", () => {
  it("archives active promos whose end date has passed", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Promo Card",
      statementDay: 15,
      dueDay: 5,
      autoPay: false,
      isActive: true,
    });
    const expired = await createPromo(user.id, card.id, {
      description: "Expired",
      originalAmountCents: 200_00,
      remainingAmountCents: 200_00,
      startDate: "2025-01-01",
      endDate: "2026-05-03",
      monthlyPaymentCents: null,
      notes: null,
      isActive: true,
    });
    const current = await createPromo(user.id, card.id, {
      description: "Current",
      originalAmountCents: 300_00,
      remainingAmountCents: 300_00,
      startDate: "2026-01-01",
      endDate: "2026-05-04",
      monthlyPaymentCents: null,
      notes: null,
      isActive: true,
    });

    expect(await archiveExpiredPromos(user.id, "2026-05-04")).toBe(1);

    const promos = await listPromos(user.id, true);
    expect(promos.find((promo) => promo.id === expired.id)?.isActive).toBe(false);
    expect(promos.find((promo) => promo.id === current.id)?.isActive).toBe(true);
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
