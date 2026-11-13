/**
 * Integration test for POST /api/plaid/exchange with a mocked Plaid client and
 * a real SQLite DB: linking a bank AGAIN must reconnect the user's existing
 * card for the same real account instead of creating a second one (review
 * 2026-11-10 PLAID-3).
 *
 * Plaid Link update mode is not built, so the only recovery from a broken
 * login is unlink (`deactivatePlaidItem`: cards stay active, their
 * `plaid_account_id` is nulled) + link again (Plaid issues NEW account_ids).
 * Before the fix the exchange auto-created a new card for the new account_id,
 * the liabilities pre-fetch gave it the same open statement, and that
 * statement was owed twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// repos.ts → ./auth → next-auth: short-circuit.
vi.mock("./auth", () => ({
  hashPassword: async (p: string) => `mock-hash-${p}`,
}));

// "server-only" sentinel module is unimportable outside Next.js — stub it.
vi.mock("server-only", () => ({}));

// The route's session + body helpers: the signed-in user is `currentUser`.
let currentUser = "";
vi.mock("./api", async () => {
  const { NextResponse } = await import("next/server");
  return {
    ensureUser: async () => ({ userId: currentUser }),
    readJson: async (req: Request) => req.json(),
    jsonError: (msg: string, status = 500) => NextResponse.json({ error: msg }, { status }),
  };
});

// Never the real Plaid API. Configured per test.
const __plaidMock = {
  itemPublicTokenExchange: vi.fn(),
  accountsGet: vi.fn(),
  liabilitiesGet: vi.fn(),
  itemRemove: vi.fn(),
};
vi.mock("./plaid-client", () => ({
  getPlaidClient: () => __plaidMock,
}));

import { __resetDbCacheForTests, getDb, runMigrations } from "./db/client";
import { users } from "./db/schema";
import { newId } from "./ids";
import {
  archiveCreditCard,
  createCreditCard,
  createPlaidItem,
  createPromo,
  createStatement,
  deactivatePlaidItem,
  getCreditCard,
  listCreditCardPaymentOverridesForUser,
  listCreditCards,
  listPromosForCard,
  listStatements,
  upsertCreditCardPaymentOverride,
  upsertPlaidAccount,
  upsertPlaidDraft,
} from "./repos";
import { encryptToken } from "./plaid-crypto";
import { addDaysIso, DEFAULT_TIMEZONE, todayIso } from "./dates";
import { POST as exchange } from "@/app/api/plaid/exchange/route";

const TODAY = todayIso(DEFAULT_TIMEZONE);
const STMT_DATE = addDaysIso(TODAY, -16);
const DUE_DATE = addDaysIso(TODAY, 9);
const CHASE = { institutionId: "ins_3", institutionName: "Chase" };
const CITI = { institutionId: "ins_5", institutionName: "Citi" };

let dbDir: string;

beforeEach(() => {
  __resetDbCacheForTests();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-plaid-exchange-"));
  process.env.DATABASE_URL = `file:${path.join(dbDir, "test.db")}`;
  process.env.PLAID_ENCRYPTION_KEY = "a".repeat(64);
  getDb();
  runMigrations();
  for (const fn of Object.values(__plaidMock)) fn.mockReset();
  __plaidMock.itemRemove.mockResolvedValue({ data: {} });
});

afterEach(() => {
  __resetDbCacheForTests();
  try {
    fs.rmSync(dbDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

async function seedUser(email = "u@x.com"): Promise<string> {
  const id = newId();
  await getDb()
    .insert(users)
    .values({ id, email, passwordHash: "x".repeat(64), displayName: "U", role: "admin" })
    .run();
  return id;
}

async function seedItem(userId: string, inst: { institutionId: string; institutionName: string }) {
  const t = encryptToken(`old-token-${newId()}`);
  return createPlaidItem(userId, {
    institutionId: inst.institutionId,
    institutionName: inst.institutionName,
    accessTokenEnc: t.enc,
    accessTokenIv: t.iv,
    accessTokenTag: t.tag,
    cursor: "c9",
    lastSyncedAt: Date.now(),
    isActive: true,
  });
}

async function seedCreditAccount(
  userId: string,
  itemId: string,
  id: string,
  mask: string | null,
  name = "Prime Visa",
) {
  await upsertPlaidAccount({
    id,
    itemId,
    userId,
    name,
    mask,
    type: "credit",
    subtype: "credit card",
    balanceCents: 1_200_00,
    updatedAt: Date.now(),
  });
}

/**
 * The durable tie a linked card keeps after an unlink: a statement paid by a
 * card_payment draft from its account (reconcileCardPaymentDraft stamps
 * `settled_by_draft_id`; the draft row keeps its `account_id`).
 */
async function seedSettledPayment(userId: string, cardId: string, accountId: string) {
  const draftId = `pay_${newId()}`;
  await upsertPlaidDraft({
    id: draftId,
    userId,
    accountId,
    date: addDaysIso(TODAY, -40),
    description: "Payment Thank You - Web",
    originalDescription: "Payment Thank You - Web",
    amountCents: -950_00,
    plaidCategory: "LOAN_PAYMENTS",
    merchantName: null,
    pending: false,
    status: "approved",
    kind: "card_payment",
    linkedExpenseId: null,
    linkedPromoId: null,
  });
  await createStatement(cardId, {
    statementDate: addDaysIso(TODAY, -46),
    dueDate: addDaysIso(TODAY, -21),
    statementBalanceCents: 950_00,
    minimumPaymentCents: 35_00,
    paidAmountCents: 950_00,
    paidDate: addDaysIso(TODAY, -40),
    notes: null,
    settledByDraftId: draftId,
  });
}

type NewAccount = { account_id: string; name: string; mask: string | null };

function mockRelink(accounts: NewAccount[], liabilityFor: string[] = []) {
  __plaidMock.itemPublicTokenExchange.mockResolvedValue({
    data: { access_token: "new-token", item_id: `plaid_item_${newId()}` },
  });
  __plaidMock.accountsGet.mockResolvedValue({
    data: {
      accounts: accounts.map((a) => ({
        ...a,
        type: "credit",
        subtype: "credit card",
        balances: { current: 1200, available: null, limit: 10000 },
      })),
    },
  });
  __plaidMock.liabilitiesGet.mockResolvedValue({
    data: {
      liabilities: {
        credit: liabilityFor.map((account_id) => ({
          account_id,
          last_statement_issue_date: STMT_DATE,
          next_payment_due_date: DUE_DATE,
          last_statement_balance: 1200,
          minimum_payment_amount: 40,
          last_payment_date: null,
          last_payment_amount: null,
        })),
      },
    },
  });
}

async function runExchange(inst: { institutionId: string; institutionName: string }) {
  const res = await exchange(
    new Request("http://localhost/api/plaid/exchange", {
      method: "POST",
      body: JSON.stringify({ publicToken: "public-x", ...inst }),
    }),
  );
  expect(res.status).toBe(201);
  return res;
}

async function unpaidStatements(userId: string) {
  const out: Array<{ card: string; dueDate: string; cents: number }> = [];
  for (const c of await listCreditCards(userId, false)) {
    for (const s of await listStatements(c.id)) {
      if (s.paidAmountCents == null) {
        out.push({ card: c.name, dueDate: s.dueDate, cents: s.statementBalanceCents });
      }
    }
  }
  return out;
}

describe("POST /api/plaid/exchange — linking a bank again reuses the existing card (PLAID-3)", () => {
  it("re-links the user's unlinked card for the same account: one card, one open statement, settings untouched", async () => {
    const userId = await seedUser();
    currentUser = userId;
    const oldItem = await seedItem(userId, CHASE);
    await seedCreditAccount(userId, oldItem.id, "acct_old", "9873");
    const card = await createCreditCard(userId, {
      name: "Chase Prime Visa",
      statementDay: 25,
      dueDay: 21,
      gracePeriodDays: 25,
      creditLimitCents: 15_000_00,
      autoPay: false,
      isActive: true,
      plaidAccountId: "acct_old",
    });
    await seedSettledPayment(userId, card.id, "acct_old");
    await createStatement(card.id, {
      statementDate: STMT_DATE,
      dueDate: DUE_DATE,
      statementBalanceCents: 1_200_00,
      minimumPaymentCents: 40_00,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });
    await createPromo(userId, card.id, {
      description: "Equal Pay plan",
      originalAmountCents: 1_800_00,
      remainingAmountCents: 1_200_00,
      startDate: addDaysIso(TODAY, -90),
      endDate: addDaysIso(TODAY, 270),
      monthlyPaymentCents: 150_00,
      notes: null,
      isActive: true,
    });
    await upsertCreditCardPaymentOverride(userId, card.id, {
      dueDate: DUE_DATE,
      amountCents: 400_00,
      notes: "Interest Saving Balance",
    });
    const promosBefore = await listPromosForCard(userId, card.id);
    const overridesBefore = await listCreditCardPaymentOverridesForUser(userId);

    // The login breaks; the app's only recovery is unlink + link again.
    await deactivatePlaidItem(userId, oldItem.id);
    mockRelink([{ account_id: "acct_new", name: "Prime Visa", mask: "9873" }], ["acct_new"]);
    await runExchange(CHASE);

    const cards = await listCreditCards(userId, false);
    expect(cards.map((c) => [c.id, c.name, c.plaidAccountId])).toEqual([
      [card.id, "Chase Prime Visa", "acct_new"],
    ]);
    const after = (await getCreditCard(userId, card.id))!;
    expect(after.gracePeriodDays).toBe(25);
    expect(after.creditLimitCents).toBe(15_000_00); // manual limit wins over Plaid's 10000
    expect(after.currentBalanceCents).toBe(1_200_00);
    expect(await unpaidStatements(userId)).toEqual([
      { card: "Chase Prime Visa", dueDate: DUE_DATE, cents: 1_200_00 },
    ]);
    expect(await listStatements(card.id)).toHaveLength(2); // the paid history + the open one
    expect(await listPromosForCard(userId, card.id)).toEqual(promosBefore);
    expect(await listCreditCardPaymentOverridesForUser(userId)).toEqual(overridesBefore);
  });

  it("keeps a manual paid record on the open statement through the re-link's liabilities upsert", async () => {
    const userId = await seedUser();
    currentUser = userId;
    const oldItem = await seedItem(userId, CHASE);
    await seedCreditAccount(userId, oldItem.id, "acct_old", "9873");
    const card = await createCreditCard(userId, {
      name: "Chase Prime Visa",
      statementDay: 25,
      dueDay: 21,
      autoPay: false,
      isActive: true,
      plaidAccountId: "acct_old",
    });
    await seedSettledPayment(userId, card.id, "acct_old");
    await createStatement(card.id, {
      statementDate: STMT_DATE,
      dueDate: DUE_DATE,
      statementBalanceCents: 1_200_00,
      minimumPaymentCents: 40_00,
      paidAmountCents: 1_200_00,
      paidDate: addDaysIso(TODAY, -1),
      notes: "paid by hand",
    });

    await deactivatePlaidItem(userId, oldItem.id);
    mockRelink([{ account_id: "acct_new", name: "Prime Visa", mask: "9873" }], ["acct_new"]);
    await runExchange(CHASE);

    const cards = await listCreditCards(userId, false);
    expect(cards.map((c) => c.id)).toEqual([card.id]);
    const open = (await listStatements(card.id)).filter((s) => s.statementDate === STMT_DATE);
    expect(open).toHaveLength(1);
    expect(open[0]!.paidAmountCents).toBe(1_200_00);
    expect(open[0]!.paidDate).toBe(addDaysIso(TODAY, -1));
    expect(await unpaidStatements(userId)).toEqual([]);
  });

  it("re-links an auto-created card by its name even without payment history", async () => {
    const userId = await seedUser();
    currentUser = userId;
    const oldItem = await seedItem(userId, CHASE);
    await seedCreditAccount(userId, oldItem.id, "acct_old", "9873");
    const card = await createCreditCard(userId, {
      name: "Prime Visa ****9873",
      statementDay: 25,
      dueDay: 21,
      autoPay: false,
      isActive: true,
      plaidAccountId: "acct_old",
    });

    await deactivatePlaidItem(userId, oldItem.id);
    mockRelink([{ account_id: "acct_new", name: "Prime Visa", mask: "9873" }], ["acct_new"]);
    await runExchange(CHASE);

    const cards = await listCreditCards(userId, false);
    expect(cards.map((c) => [c.id, c.plaidAccountId])).toEqual([[card.id, "acct_new"]]);
    expect(await unpaidStatements(userId)).toHaveLength(1);
  });

  it("does not guess for two unlinked cards with the same last 4 at the same bank: a new card is created", async () => {
    const userId = await seedUser();
    currentUser = userId;
    const oldItem = await seedItem(userId, CHASE);
    await seedCreditAccount(userId, oldItem.id, "acct_old_a", "9873");
    await seedCreditAccount(userId, oldItem.id, "acct_old_b", "9873", "Freedom");
    const a = await createCreditCard(userId, {
      name: "Chase Prime Visa", statementDay: 25, dueDay: 21, autoPay: false, isActive: true,
      plaidAccountId: "acct_old_a",
    });
    const b = await createCreditCard(userId, {
      name: "Chase Freedom", statementDay: 10, dueDay: 5, autoPay: false, isActive: true,
      plaidAccountId: "acct_old_b",
    });
    await seedSettledPayment(userId, a.id, "acct_old_a");
    await seedSettledPayment(userId, b.id, "acct_old_b");

    await deactivatePlaidItem(userId, oldItem.id);
    mockRelink([{ account_id: "acct_new", name: "Prime Visa", mask: "9873" }]);
    await runExchange(CHASE);

    const cards = await listCreditCards(userId, false);
    expect(cards).toHaveLength(3);
    expect((await getCreditCard(userId, a.id))!.plaidAccountId).toBeNull();
    expect((await getCreditCard(userId, b.id))!.plaidAccountId).toBeNull();
    expect(cards.find((c) => c.plaidAccountId === "acct_new")!.name).toBe("Prime Visa ****9873");
  });

  it("does not guess when the bank returns two new accounts with the same last 4", async () => {
    const userId = await seedUser();
    currentUser = userId;
    const oldItem = await seedItem(userId, CHASE);
    await seedCreditAccount(userId, oldItem.id, "acct_old", "9873");
    const card = await createCreditCard(userId, {
      name: "Chase Prime Visa", statementDay: 25, dueDay: 21, autoPay: false, isActive: true,
      plaidAccountId: "acct_old",
    });
    await seedSettledPayment(userId, card.id, "acct_old");

    await deactivatePlaidItem(userId, oldItem.id);
    mockRelink([
      { account_id: "acct_new_1", name: "Prime Visa", mask: "9873" },
      { account_id: "acct_new_2", name: "Prime Visa", mask: "9873" },
    ]);
    await runExchange(CHASE);

    expect((await getCreditCard(userId, card.id))!.plaidAccountId).toBeNull();
    const linked = (await listCreditCards(userId, false)).filter((c) => c.plaidAccountId != null);
    expect(linked.map((c) => c.plaidAccountId).sort()).toEqual(["acct_new_1", "acct_new_2"]);
  });

  it("does not re-link a card whose former account had the same last 4 at a DIFFERENT bank", async () => {
    const userId = await seedUser();
    currentUser = userId;
    const citiItem = await seedItem(userId, CITI);
    await seedCreditAccount(userId, citiItem.id, "acct_citi", "9873", "Double Cash");
    const citiCard = await createCreditCard(userId, {
      name: "Double Cash ****9873", statementDay: 3, dueDay: 28, autoPay: false, isActive: true,
      plaidAccountId: "acct_citi",
    });
    await seedSettledPayment(userId, citiCard.id, "acct_citi");

    await deactivatePlaidItem(userId, citiItem.id);
    mockRelink([{ account_id: "acct_new", name: "Prime Visa", mask: "9873" }]);
    await runExchange(CHASE);

    expect((await getCreditCard(userId, citiCard.id))!.plaidAccountId).toBeNull();
    const cards = await listCreditCards(userId, false);
    expect(cards).toHaveLength(2);
    expect(cards.find((c) => c.plaidAccountId === "acct_new")!.name).toBe("Prime Visa ****9873");
  });

  it("never re-links an archived card", async () => {
    const userId = await seedUser();
    currentUser = userId;
    const oldItem = await seedItem(userId, CHASE);
    await seedCreditAccount(userId, oldItem.id, "acct_old", "9873");
    const card = await createCreditCard(userId, {
      name: "Prime Visa ****9873", statementDay: 25, dueDay: 21, autoPay: false, isActive: true,
      plaidAccountId: "acct_old",
    });
    await seedSettledPayment(userId, card.id, "acct_old");
    await deactivatePlaidItem(userId, oldItem.id);
    await archiveCreditCard(userId, card.id);

    mockRelink([{ account_id: "acct_new", name: "Prime Visa", mask: "9873" }]);
    await runExchange(CHASE);

    const archived = (await getCreditCard(userId, card.id))!;
    expect(archived.isActive).toBe(false);
    expect(archived.plaidAccountId).toBeNull();
    const active = await listCreditCards(userId, false);
    expect(active.map((c) => [c.name, c.plaidAccountId])).toEqual([
      ["Prime Visa ****9873", "acct_new"],
    ]);
    expect(active[0]!.id).not.toBe(card.id);
  });

  it("never touches another user's card with the same last 4", async () => {
    const otherId = await seedUser("other@x.com");
    const otherItem = await seedItem(otherId, CHASE);
    await seedCreditAccount(otherId, otherItem.id, "acct_other", "9873");
    const otherCard = await createCreditCard(otherId, {
      name: "Prime Visa ****9873", statementDay: 25, dueDay: 21, autoPay: false, isActive: true,
      plaidAccountId: "acct_other",
    });
    await seedSettledPayment(otherId, otherCard.id, "acct_other");
    await deactivatePlaidItem(otherId, otherItem.id);
    const otherBefore = (await getCreditCard(otherId, otherCard.id))!;

    const userId = await seedUser();
    currentUser = userId;
    mockRelink([{ account_id: "acct_new", name: "Prime Visa", mask: "9873" }]);
    await runExchange(CHASE);

    expect(await getCreditCard(otherId, otherCard.id)).toEqual(otherBefore);
    const mine = await listCreditCards(userId, false);
    expect(mine.map((c) => [c.name, c.plaidAccountId])).toEqual([["Prime Visa ****9873", "acct_new"]]);
  });

  it("creates cards as before on a first-ever link", async () => {
    const userId = await seedUser();
    currentUser = userId;
    mockRelink(
      [
        { account_id: "acct_a", name: "Prime Visa", mask: "9873" },
        { account_id: "acct_b", name: "Freedom", mask: "1154" },
      ],
      ["acct_a"],
    );
    await runExchange(CHASE);

    const cards = await listCreditCards(userId, false);
    expect(cards.map((c) => [c.name, c.plaidAccountId])).toEqual([
      ["Freedom ****1154", "acct_b"],
      ["Prime Visa ****9873", "acct_a"],
    ]);
    expect(await unpaidStatements(userId)).toHaveLength(1);
  });

  it("re-links the one matching account and creates a card for the other", async () => {
    const userId = await seedUser();
    currentUser = userId;
    const oldItem = await seedItem(userId, CHASE);
    await seedCreditAccount(userId, oldItem.id, "acct_old", "9873");
    const card = await createCreditCard(userId, {
      name: "Chase Prime Visa", statementDay: 25, dueDay: 21, autoPay: false, isActive: true,
      plaidAccountId: "acct_old",
    });
    await seedSettledPayment(userId, card.id, "acct_old");

    await deactivatePlaidItem(userId, oldItem.id);
    mockRelink(
      [
        { account_id: "acct_new", name: "Prime Visa", mask: "9873" },
        { account_id: "acct_freedom", name: "Freedom", mask: "1154" },
      ],
      ["acct_new"],
    );
    await runExchange(CHASE);

    const cards = await listCreditCards(userId, false);
    expect(cards.map((c) => [c.id === card.id, c.name, c.plaidAccountId])).toEqual([
      [true, "Chase Prime Visa", "acct_new"],
      [false, "Freedom ****1154", "acct_freedom"],
    ]);
  });

  it("does not re-link when Plaid reports no mask for the new account", async () => {
    const userId = await seedUser();
    currentUser = userId;
    const oldItem = await seedItem(userId, CHASE);
    await seedCreditAccount(userId, oldItem.id, "acct_old", "9873");
    const card = await createCreditCard(userId, {
      name: "Chase Prime Visa", statementDay: 25, dueDay: 21, autoPay: false, isActive: true,
      plaidAccountId: "acct_old",
    });
    await seedSettledPayment(userId, card.id, "acct_old");

    await deactivatePlaidItem(userId, oldItem.id);
    mockRelink([{ account_id: "acct_new", name: "Prime Visa", mask: null }]);
    await runExchange(CHASE);

    expect((await getCreditCard(userId, card.id))!.plaidAccountId).toBeNull();
    const created = (await listCreditCards(userId, false)).find((c) => c.plaidAccountId === "acct_new");
    expect(created!.name).toBe("Prime Visa");
  });

  it("does not guess for a hand-named card with nothing that ties it to its former account", async () => {
    const userId = await seedUser();
    currentUser = userId;
    const oldItem = await seedItem(userId, CHASE);
    await seedCreditAccount(userId, oldItem.id, "acct_old", "9873");
    const card = await createCreditCard(userId, {
      name: "Chase Prime Visa", statementDay: 25, dueDay: 21, autoPay: false, isActive: true,
      plaidAccountId: "acct_old",
    });

    await deactivatePlaidItem(userId, oldItem.id);
    mockRelink([{ account_id: "acct_new", name: "Prime Visa", mask: "9873" }]);
    await runExchange(CHASE);

    expect((await getCreditCard(userId, card.id))!.plaidAccountId).toBeNull();
    expect(await listCreditCards(userId, false)).toHaveLength(2);
  });
});
