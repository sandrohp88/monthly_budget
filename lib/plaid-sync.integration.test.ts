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
  transactionsSync: vi.fn(),
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
  createPromo,
  createStatement,
  getPromo,
  upsertPlaidAccount,
  setCreditCardPlaidLink,
  getCreditCard,
  listPromosForCard,
  listStatements,
  updatePromo,
} from "./repos";
import { encryptToken } from "./plaid-crypto";
import { syncCreditCardLiabilitiesForItem, syncPlaidTransactions } from "./plaid-sync";
import { addDaysIso, todayIso } from "./dates";
import { addMonthsClampedIso } from "./paypal-special-financing";

// Fixture dates are computed relative to today so the tests don't rot as real
// time passes: `archiveExpiredPromos` runs on every sync and zeroes any active
// promo whose endDate (purchase + 6 months) is behind the real clock, which
// silently broke the original hard-coded 2026 dates.
const TODAY = todayIso();

let dbDir: string;

beforeEach(() => {
  __resetDbCacheForTests();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-plaid-int-"));
  process.env.DATABASE_URL = `file:${path.join(dbDir, "test.db")}`;
  process.env.PLAID_ENCRYPTION_KEY = "a".repeat(64);
  getDb();
  runMigrations();
  __plaidMock.liabilitiesGet.mockReset();
  __plaidMock.transactionsSync.mockReset();
});

afterEach(() => {
  __resetDbCacheForTests();
  try {
    fs.rmSync(dbDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("syncPlaidTransactions PayPal special financing", () => {
  it("seeds PayPal wallet promos at full purchase amount and never rewrites them from payments", async () => {
    const user = await makeUser();
    const token = encryptToken("access-token");
    const item = await createPlaidItem(user.id, {
      institutionId: "ins_paypal",
      institutionName: "PayPal",
      accessTokenEnc: token.enc,
      accessTokenIv: token.iv,
      accessTokenTag: token.tag,
      cursor: null,
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: "acct_paypal_credit",
      itemId: item.id,
      userId: user.id,
      name: "PayPal Credit Card",
      mask: "9288",
      type: "credit",
      subtype: "paypal",
      balanceCents: 3885_49,
      updatedAt: Date.now(),
    });
    await upsertPlaidAccount({
      id: "acct_paypal_wallet",
      itemId: item.id,
      userId: user.id,
      name: "PayPal",
      mask: null,
      type: "depository",
      subtype: "paypal",
      balanceCents: 0,
      updatedAt: Date.now(),
    });
    const card = await createCreditCard(user.id, {
      name: "PayPal Credit Card ****9288",
      statementDay: 30,
      dueDay: 26,
      autoPay: false,
      isActive: true,
    });
    await setCreditCardPlaidLink(user.id, card.id, "acct_paypal_credit");

    // Purchase anchor ~1 month back; promos end 6 months later (still active).
    const temuDate = addDaysIso(TODAY, -30);
    const lightEleganceDate = addDaysIso(temuDate, 11);

    __plaidMock.transactionsSync.mockResolvedValue({
      data: {
        next_cursor: "cursor_1",
        has_more: false,
        accounts: [],
        added: [
          {
            transaction_id: "payment_before",
            account_id: "acct_paypal_credit",
            pending: false,
            date: addDaysIso(temuDate, -5),
            name: "PayPal Credit Card",
            original_description: "PayPal Credit Card",
            amount: 354.66,
            personal_finance_category: { primary: "LOAN_PAYMENTS" },
            merchant_name: null,
          },
          {
            transaction_id: "purchase_1",
            account_id: "acct_paypal_wallet",
            pending: false,
            date: temuDate,
            name: "Payment to Temu.com",
            original_description: "Payment to Temu.com",
            amount: 250.92,
            personal_finance_category: { primary: "GENERAL_MERCHANDISE" },
            merchant_name: "Temu",
          },
          {
            transaction_id: "small_purchase",
            account_id: "acct_paypal_wallet",
            pending: false,
            date: addDaysIso(temuDate, -1),
            name: "Payment to Coffee Shop",
            original_description: "Payment to Coffee Shop",
            amount: 50,
            personal_finance_category: { primary: "FOOD_AND_DRINK" },
            merchant_name: "Coffee Shop",
          },
          {
            transaction_id: "purchase_2",
            account_id: "acct_paypal_wallet",
            pending: false,
            date: lightEleganceDate,
            name: "Payment to Light Elegance",
            original_description: "Payment to Light Elegance",
            amount: 275.46,
            personal_finance_category: { primary: "PERSONAL_CARE" },
            merchant_name: "Light Elegance",
          },
          {
            transaction_id: "payment_after",
            account_id: "acct_paypal_credit",
            pending: false,
            date: addDaysIso(temuDate, 18),
            name: "PayPal Credit Card",
            original_description: "PayPal Credit Card",
            amount: 188.47,
            personal_finance_category: { primary: "LOAN_PAYMENTS" },
            merchant_name: null,
          },
        ],
        modified: [],
        removed: [],
      },
    });
    __plaidMock.liabilitiesGet.mockResolvedValue({ data: { liabilities: { credit: [] } } });

    await syncPlaidTransactions(user.id, item.id);
    await syncPlaidTransactions(user.id, item.id);

    const promos = await listPromosForCard(user.id, card.id, true);
    expect(promos).toHaveLength(2);
    expect(promos.map((promo) => promo.description)).toEqual(["Temu", "Light Elegance"]);
    // Seed-only: the LOAN_PAYMENTS rows in the feed must NOT shrink these —
    // Plaid doesn't expose PayPal's targeted allocation, so amounts only
    // change via the statement decrement edge or the promo-list reconcile.
    expect(promos.map((promo) => promo.remainingAmountCents)).toEqual([250_92, 275_46]);
    expect(promos.map((promo) => promo.endDate)).toEqual([
      addMonthsClampedIso(temuDate, 6),
      addMonthsClampedIso(lightEleganceDate, 6),
    ]);
  });

  it("preserves PayPal promo rows reconciled from the issuer promo list", async () => {
    const user = await makeUser();
    const token = encryptToken("access-token");
    const item = await createPlaidItem(user.id, {
      institutionId: "ins_paypal",
      institutionName: "PayPal",
      accessTokenEnc: token.enc,
      accessTokenIv: token.iv,
      accessTokenTag: token.tag,
      cursor: null,
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: "acct_paypal_credit",
      itemId: item.id,
      userId: user.id,
      name: "PayPal Credit Card",
      mask: "9288",
      type: "credit",
      subtype: "paypal",
      balanceCents: 400_00,
      updatedAt: Date.now(),
    });
    await upsertPlaidAccount({
      id: "acct_paypal_wallet",
      itemId: item.id,
      userId: user.id,
      name: "PayPal",
      mask: null,
      type: "depository",
      subtype: "paypal",
      balanceCents: 0,
      updatedAt: Date.now(),
    });
    const card = await createCreditCard(user.id, {
      name: "PayPal Credit Card ****9288",
      statementDay: 30,
      dueDay: 26,
      autoPay: false,
      isActive: true,
    });
    await setCreditCardPlaidLink(user.id, card.id, "acct_paypal_credit");

    // Recent purchases so the auto-created 6-month promos are still active
    // when the sweep runs; the authoritative endDates below are then set
    // relative to today (one future, one already past + paid off).
    const storeOneDate = addDaysIso(TODAY, -30);
    const storeOneEnd = addDaysIso(TODAY, 20);
    const storeTwoEnd = addDaysIso(TODAY, -10);

    __plaidMock.transactionsSync.mockResolvedValue({
      data: {
        next_cursor: "cursor_1",
        has_more: false,
        accounts: [],
        added: [
          {
            transaction_id: "purchase_1",
            account_id: "acct_paypal_wallet",
            pending: false,
            date: storeOneDate,
            name: "Payment to Store One",
            original_description: "Payment to Store One",
            amount: 200.00,
            personal_finance_category: { primary: "GENERAL_MERCHANDISE" },
            merchant_name: "Store One",
          },
          {
            transaction_id: "purchase_2",
            account_id: "acct_paypal_wallet",
            pending: false,
            date: addDaysIso(storeOneDate, 1),
            name: "Payment to Store Two",
            original_description: "Payment to Store Two",
            amount: 200.00,
            personal_finance_category: { primary: "GENERAL_MERCHANDISE" },
            merchant_name: "Store Two",
          },
          {
            transaction_id: "payment_1",
            account_id: "acct_paypal_credit",
            pending: false,
            date: addDaysIso(storeOneDate, 2),
            name: "PayPal Credit Card",
            original_description: "PayPal Credit Card",
            amount: 50.00,
            personal_finance_category: { primary: "LOAN_PAYMENTS" },
            merchant_name: null,
          },
        ],
        modified: [],
        removed: [],
      },
    });
    __plaidMock.liabilitiesGet.mockResolvedValue({ data: { liabilities: { credit: [] } } });

    await syncPlaidTransactions(user.id, item.id);
    let promos = await listPromosForCard(user.id, card.id, true);
    // Seeded at full purchase amounts — the $50 payment row is ignored.
    expect(promos.map((promo) => promo.remainingAmountCents)).toEqual([200_00, 200_00]);

    const storeOne = promos.find((promo) => promo.description === "Store One")!;
    const storeTwo = promos.find((promo) => promo.description === "Store Two")!;
    await updatePromo(user.id, storeOne.id, {
      remainingAmountCents: 200_00,
      endDate: storeOneEnd,
      notes: "Copied from PayPal promo list",
      authoritativeSource: "paypal_promo_list",
      isActive: true,
    });
    await updatePromo(user.id, storeTwo.id, {
      remainingAmountCents: 0,
      endDate: storeTwoEnd,
      notes: "Paid off per PayPal promo list",
      authoritativeSource: "paypal_promo_list",
      isActive: false,
    });

    await syncPlaidTransactions(user.id, item.id);

    promos = await listPromosForCard(user.id, card.id, true);
    expect(promos.map((promo) => promo.description)).toEqual(["Store Two", "Store One"]);
    expect(promos.map((promo) => promo.remainingAmountCents)).toEqual([0, 200_00]);
    expect(promos.map((promo) => promo.endDate)).toEqual([storeTwoEnd, storeOneEnd]);
    expect(promos.map((promo) => promo.isActive)).toEqual([false, true]);
  });
});

describe("syncPlaidTransactions card-payment reconciliation", () => {
  it("marks the matching open statement paid and decrements promos from a LOAN_PAYMENTS draft", async () => {
    const user = await makeUser();
    const token = encryptToken("access-token");
    const item = await createPlaidItem(user.id, {
      institutionId: "ins_chase",
      institutionName: "Chase",
      accessTokenEnc: token.enc,
      accessTokenIv: token.iv,
      accessTokenTag: token.tag,
      cursor: null,
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: "acct_card",
      itemId: item.id,
      userId: user.id,
      name: "Sapphire",
      mask: "1111",
      type: "credit",
      subtype: "credit card",
      balanceCents: 300_00,
      updatedAt: Date.now(),
    });
    const card = await createCreditCard(user.id, {
      name: "Sapphire",
      statementDay: 30,
      dueDay: 26,
      autoPay: true,
      isActive: true,
    });
    await setCreditCardPlaidLink(user.id, card.id, "acct_card");

    const today = todayIso();
    const statementDate = addDaysIso(today, -26);
    const promo = await createPromo(user.id, card.id, {
      description: "TV installment",
      originalAmountCents: 600_00,
      remainingAmountCents: 600_00,
      startDate: addDaysIso(today, -60),
      endDate: addDaysIso(today, 180),
      monthlyPaymentCents: 100_00,
      notes: null,
      isActive: true,
    });
    const statement = await createStatement(card.id, {
      statementDate,
      dueDate: today,
      statementBalanceCents: 300_00,
      minimumPaymentCents: null,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });

    __plaidMock.transactionsSync.mockResolvedValue({
      data: {
        next_cursor: "c1",
        has_more: false,
        accounts: [],
        added: [
          {
            transaction_id: "pay_1",
            account_id: "acct_card",
            pending: false,
            date: today,
            name: "Autopay Payment Thank You",
            original_description: "AUTOPAY PAYMENT",
            amount: 300.0,
            personal_finance_category: {
              primary: "LOAN_PAYMENTS",
              detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
            },
            merchant_name: null,
          },
        ],
        modified: [],
        removed: [],
      },
    });
    __plaidMock.liabilitiesGet.mockResolvedValue({ data: { liabilities: { credit: [] } } });

    const result = await syncPlaidTransactions(user.id, item.id);
    expect(result.statementsReconciled).toBe(1);

    const settled = (await listStatements(card.id)).find((s) => s.id === statement.id)!;
    expect(settled.paidAmountCents).toBe(300_00);
    expect(settled.paidDate).toBe(today);

    // Promo decremented once by its monthly chunk ($100), not double-counted.
    expect((await getPromo(user.id, promo.id))!.remainingAmountCents).toBe(500_00);

    // Re-sync is idempotent: the now-paid statement won't re-match.
    const again = await syncPlaidTransactions(user.id, item.id);
    expect(again.statementsReconciled).toBe(0);
    expect((await getPromo(user.id, promo.id))!.remainingAmountCents).toBe(500_00);
  });

  it("does not reconcile a payment that matches no open statement", async () => {
    const user = await makeUser();
    const token = encryptToken("access-token");
    const item = await createPlaidItem(user.id, {
      institutionId: "ins_chase",
      institutionName: "Chase",
      accessTokenEnc: token.enc,
      accessTokenIv: token.iv,
      accessTokenTag: token.tag,
      cursor: null,
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: "acct_card2",
      itemId: item.id,
      userId: user.id,
      name: "Sapphire",
      mask: "1111",
      type: "credit",
      subtype: "credit card",
      balanceCents: 300_00,
      updatedAt: Date.now(),
    });
    const card = await createCreditCard(user.id, {
      name: "Sapphire",
      statementDay: 30,
      dueDay: 26,
      autoPay: true,
      isActive: true,
    });
    await setCreditCardPlaidLink(user.id, card.id, "acct_card2");
    const today = todayIso();
    await createStatement(card.id, {
      statementDate: addDaysIso(today, -26),
      dueDate: today,
      statementBalanceCents: 300_00,
      minimumPaymentCents: null,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });

    __plaidMock.transactionsSync.mockResolvedValue({
      data: {
        next_cursor: "c1",
        has_more: false,
        accounts: [],
        added: [
          {
            transaction_id: "pay_x",
            account_id: "acct_card2",
            pending: false,
            date: today,
            name: "Autopay Payment",
            original_description: "AUTOPAY",
            // $500 is not within 10% of the $300 statement → no match.
            amount: 500.0,
            personal_finance_category: { primary: "LOAN_PAYMENTS" },
            merchant_name: null,
          },
        ],
        modified: [],
        removed: [],
      },
    });
    __plaidMock.liabilitiesGet.mockResolvedValue({ data: { liabilities: { credit: [] } } });

    const result = await syncPlaidTransactions(user.id, item.id);
    expect(result.statementsReconciled).toBe(0);
    const stmts = await listStatements(card.id);
    expect(stmts[0]!.paidAmountCents).toBeNull();
  });
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
              minimum_payment_amount: 45.67,
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
      minimumPaymentCents: 4567,
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
              minimum_payment_amount: 0.1 + 0.2,
            },
          ],
        },
      },
    });
    await syncCreditCardLiabilitiesForItem(user.id, item.id, "tok");
    const stmts = await listStatements(card.id);
    expect(stmts[0]?.statementBalanceCents).toBe(30);
    expect(stmts[0]?.minimumPaymentCents).toBe(30);
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
