/**
 * Integration test for syncCreditCardLiabilitiesForItem with a mocked Plaid
 * client and a real in-memory SQLite DB. Verifies the end-to-end flow:
 *   Plaid liabilities → match by plaid_account_id → update card cycle days
 *   + upsert statement (idempotent + paid-detection).
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

// Mock the Plaid client. The mock's behavior is configured per-test by
// reaching into __plaidMock.
const __plaidMock = {
  liabilitiesGet: vi.fn(),
};
vi.mock("./plaid-client", () => ({
  getPlaidClient: () => __plaidMock,
}));

import { __resetDbCacheForTests, getDb, runMigrations } from "./db/client";
import { users } from "./db/schema";
import { newId } from "./ids";
import {
  createCreditCard,
  createPlaidItem,
  upsertPlaidAccount,
  setCreditCardPlaidLink,
  getCreditCard,
  listStatements,
} from "./repos";
import { syncCreditCardLiabilitiesForItem } from "./plaid-sync";

let dbDir: string;

beforeEach(() => {
  __resetDbCacheForTests();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-plaid-int-"));
  process.env.DATABASE_URL = `file:${path.join(dbDir, "test.db")}`;
  process.env.PLAID_ENCRYPTION_KEY = "a".repeat(64);
  getDb();
  runMigrations();
  __plaidMock.liabilitiesGet.mockReset();
});

afterEach(() => {
  __resetDbCacheForTests();
  try {
    fs.rmSync(dbDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

async function makeUser() {
  const db = getDb();
  const id = newId();
  await db
    .insert(users)
    .values({
      id,
      email: "u@x.com",
      passwordHash: "x".repeat(64),
      displayName: "U",
      role: "admin",
    })
    .run();
  return { id };
}

async function seedLinkedCard(userId: string, plaidAccountId = "acct_cc") {
  const item = await createPlaidItem(userId, {
    institutionId: "ins", institutionName: "Test Bank",
    accessTokenEnc: "00", accessTokenIv: "00", accessTokenTag: "00",
    cursor: null, lastSyncedAt: null, isActive: true,
  });
  await upsertPlaidAccount({
    id: plaidAccountId, itemId: item.id, userId, name: "Test Credit",
    mask: "1234", type: "credit", subtype: "credit card",
    balanceCents: 50_00, updatedAt: Date.now(),
  });
  const card = await createCreditCard(userId, {
    name: "My Card", statementDay: 1, dueDay: 21, autoPay: false, isActive: true,
  });
  await setCreditCardPlaidLink(userId, card.id, plaidAccountId);
  return { item, card, plaidAccountId };
}

describe("syncCreditCardLiabilitiesForItem (mocked Plaid + real SQLite)", () => {
  it("updates cycle days + creates a statement from a liabilities response", async () => {
    const user = await makeUser();
    const { item, card, plaidAccountId } = await seedLinkedCard(user.id);

    __plaidMock.liabilitiesGet.mockResolvedValue({
      data: {
        liabilities: {
          credit: [
            {
              account_id: plaidAccountId,
              last_statement_issue_date: "2025-03-15",
              next_payment_due_date: "2025-04-05",
              last_statement_balance: 1234.56,
              last_payment_date: null,
              last_payment_amount: null,
            },
          ],
        },
      },
    });

    const result = await syncCreditCardLiabilitiesForItem(user.id, item.id, "tok");
    expect(result).toEqual({ cardsUpdated: 1, statementsCreated: 1 });

    const updated = await getCreditCard(user.id, card.id);
    expect(updated?.statementDay).toBe(15);
    expect(updated?.dueDay).toBe(5);

    const stmts = await listStatements(card.id);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatchObject({
      statementDate: "2025-03-15",
      dueDate: "2025-04-05",
      statementBalanceCents: 123456,
      paidAmountCents: null,
      paidDate: null,
    });
  });

  it("marks the statement paid when last payment covers the balance on/after issue date", async () => {
    const user = await makeUser();
    const { item, card, plaidAccountId } = await seedLinkedCard(user.id);

    __plaidMock.liabilitiesGet.mockResolvedValue({
      data: {
        liabilities: {
          credit: [
            {
              account_id: plaidAccountId,
              last_statement_issue_date: "2025-03-15",
              next_payment_due_date: "2025-04-05",
              last_statement_balance: 200.00,
              last_payment_date: "2025-04-04",
              last_payment_amount: 200.00,
            },
          ],
        },
      },
    });

    await syncCreditCardLiabilitiesForItem(user.id, item.id, "tok");
    const stmts = await listStatements(card.id);
    expect(stmts[0]).toMatchObject({
      paidAmountCents: 200_00,
      paidDate: "2025-04-04",
    });
  });

  it("does NOT mark paid when last payment was for the prior cycle", async () => {
    const user = await makeUser();
    const { item, card, plaidAccountId } = await seedLinkedCard(user.id);

    __plaidMock.liabilitiesGet.mockResolvedValue({
      data: {
        liabilities: {
          credit: [
            {
              account_id: plaidAccountId,
              last_statement_issue_date: "2025-03-15",
              next_payment_due_date: "2025-04-05",
              last_statement_balance: 200.00,
              // payment was BEFORE the most recent statement issue
              last_payment_date: "2025-03-01",
              last_payment_amount: 180.00,
            },
          ],
        },
      },
    });

    await syncCreditCardLiabilitiesForItem(user.id, item.id, "tok");
    const stmts = await listStatements(card.id);
    expect(stmts[0]?.paidAmountCents).toBeNull();
    expect(stmts[0]?.paidDate).toBeNull();
  });

  it("derives the due date from card.dueDay when Plaid omits next_payment_due_date", async () => {
    const user = await makeUser();
    const { item, card, plaidAccountId } = await seedLinkedCard(user.id);

    __plaidMock.liabilitiesGet.mockResolvedValue({
      data: {
        liabilities: {
          credit: [
            {
              account_id: plaidAccountId,
              last_statement_issue_date: "2025-03-15",
              next_payment_due_date: null,
              last_statement_balance: 100.00,
            },
          ],
        },
      },
    });

    await syncCreditCardLiabilitiesForItem(user.id, item.id, "tok");
    const stmts = await listStatements(card.id);
    // card was seeded with dueDay=21. dueDateFromStatement("2025-03-15", 21)
    // = nextDayOfMonthOnOrAfter("2025-03-29", 21) = "2025-04-21".
    expect(stmts[0]?.dueDate).toBe("2025-04-21");
    // Cycle days only get updated when BOTH stmt + due dates are present, so
    // dueDay should remain at the placeholder of 21 (matches our fallback).
    const updated = await getCreditCard(user.id, card.id);
    expect(updated?.dueDay).toBe(21);
  });

  it("silently skips Plaid credit accounts not linked to any manual card", async () => {
    const user = await makeUser();
    const { item } = await seedLinkedCard(user.id, "linked");
    // Add another Plaid credit account that is NOT linked to a card.
    await upsertPlaidAccount({
      id: "unlinked", itemId: item.id, userId: user.id, name: "Other Credit",
      mask: null, type: "credit", subtype: "credit card",
      balanceCents: 0, updatedAt: Date.now(),
    });

    __plaidMock.liabilitiesGet.mockResolvedValue({
      data: {
        liabilities: {
          credit: [
            {
              account_id: "unlinked",
              last_statement_issue_date: "2025-03-15",
              next_payment_due_date: "2025-04-05",
              last_statement_balance: 999.00,
            },
          ],
        },
      },
    });

    const result = await syncCreditCardLiabilitiesForItem(user.id, item.id, "tok");
    expect(result).toEqual({ cardsUpdated: 0, statementsCreated: 0 });
  });

  it("treats a thrown liabilitiesGet as non-fatal (bank doesn't support Liabilities)", async () => {
    const user = await makeUser();
    const { item, card } = await seedLinkedCard(user.id);
    __plaidMock.liabilitiesGet.mockRejectedValue(new Error("PRODUCT_NOT_READY"));

    const result = await syncCreditCardLiabilitiesForItem(user.id, item.id, "tok");
    expect(result).toEqual({ cardsUpdated: 0, statementsCreated: 0 });
    // Card cycle days unchanged.
    const after = await getCreditCard(user.id, card.id);
    expect(after?.statementDay).toBe(1);
    expect(after?.dueDay).toBe(21);
  });

  it("is idempotent — running twice with the same response upserts in place", async () => {
    const user = await makeUser();
    const { item, card, plaidAccountId } = await seedLinkedCard(user.id);

    __plaidMock.liabilitiesGet.mockResolvedValue({
      data: {
        liabilities: {
          credit: [
            {
              account_id: plaidAccountId,
              last_statement_issue_date: "2025-03-15",
              next_payment_due_date: "2025-04-05",
              last_statement_balance: 100.00,
            },
          ],
        },
      },
    });

    await syncCreditCardLiabilitiesForItem(user.id, item.id, "tok");
    await syncCreditCardLiabilitiesForItem(user.id, item.id, "tok");
    const stmts = await listStatements(card.id);
    expect(stmts).toHaveLength(1);
  });

  it("rounds floating-point balances to integer cents (no FP drift)", async () => {
    const user = await makeUser();
    const { item, card, plaidAccountId } = await seedLinkedCard(user.id);
    __plaidMock.liabilitiesGet.mockResolvedValue({
      data: {
        liabilities: {
          credit: [
            {
              account_id: plaidAccountId,
              last_statement_issue_date: "2025-03-15",
              next_payment_due_date: "2025-04-05",
              last_statement_balance: 0.1 + 0.2, // notorious FP value
            },
          ],
        },
      },
    });
    await syncCreditCardLiabilitiesForItem(user.id, item.id, "tok");
    const stmts = await listStatements(card.id);
    expect(stmts[0]?.statementBalanceCents).toBe(30);
  });

  it("ignores liabilities with bogus day numbers (e.g. day=0 or day=99)", async () => {
    const user = await makeUser();
    const { item, card, plaidAccountId } = await seedLinkedCard(user.id);
    __plaidMock.liabilitiesGet.mockResolvedValue({
      data: {
        liabilities: {
          credit: [
            {
              account_id: plaidAccountId,
              // garbage / unparseable date components
              last_statement_issue_date: "2025-03-00",
              next_payment_due_date: "2025-04-99",
              last_statement_balance: 100.00,
            },
          ],
        },
      },
    });
    const result = await syncCreditCardLiabilitiesForItem(user.id, item.id, "tok");
    // Cycle days untouched; statement still upserts because stmtDate is non-null
    // even though parsed day is 0 — but cycle update is gated on the 1..31 check.
    expect(result.cardsUpdated).toBe(0);
    const after = await getCreditCard(user.id, card.id);
    expect(after?.statementDay).toBe(1);
    expect(after?.dueDay).toBe(21);
  });
});
