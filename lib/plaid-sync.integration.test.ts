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
  accountsGet: vi.fn(),
  accountsBalanceGet: vi.fn(),
};
vi.mock("./plaid-client", () => ({
  getPlaidClient: () => __plaidMock,
}));

import { __resetDbCacheForTests, getDb, runMigrations } from "./db/client";
import { users } from "./db/schema";
import { newId } from "./ids";
import {
  createCreditCard,
  createPaycheck,
  createPlaidItem,
  createPromo,
  createStatement,
  getPaycheck,
  getPromo,
  getPlaidDraft,
  upsertPlaidAccount,
  upsertPlaidDraft,
  setCreditCardPlaidLink,
  getCreditCard,
  listPromosForCard,
  listStatements,
  updatePaycheck,
  updatePromo,
  updateCreditCard,
  listPlaidAccounts,
} from "./repos";
import { encryptToken } from "./plaid-crypto";
import {
  BALANCE_REFRESH_MIN_INTERVAL_MS,
  refreshLiveBalancesForItem,
  syncCreditCardLiabilitiesForItem,
  syncPlaidTransactions,
} from "./plaid-sync";
import { addDaysIso, DEFAULT_TIMEZONE, todayIso } from "./dates";
import { addMonthsClampedIso } from "./paypal-special-financing";

// Fixture dates are computed relative to today so six-month promo windows stay
// meaningful regardless of when the suite runs.
const TODAY = todayIso(DEFAULT_TIMEZONE);

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
  __plaidMock.accountsGet.mockReset();
  __plaidMock.accountsBalanceGet.mockReset();
  // Default: the account refresh finds nothing to update. Tests that care
  // about balances or credit lines override this.
  __plaidMock.accountsGet.mockResolvedValue({ data: { accounts: [] } });
  // Default: no live balance payload. The call is only made for depository
  // accounts flagged useAsStartingBalance, which most fixtures don't have.
  __plaidMock.accountsBalanceGet.mockResolvedValue({ data: { accounts: [] } });
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

    // Reconcile one expired promo with a remaining issuer balance and one
    // expired paid-off promo. A later sync must preserve both actual states.
    const storeOneDate = addDaysIso(TODAY, -30);
    const storeOneEnd = addDaysIso(TODAY, -5);
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
  it("marks the matching statement paid without inferring promo allocation", async () => {
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

    const today = todayIso(DEFAULT_TIMEZONE);
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

    // Plaid identifies the card payment, but not the amount allocated to this
    // promo, so the issuer-reconciled balance stays unchanged.
    expect((await getPromo(user.id, promo.id))!.remainingAmountCents).toBe(600_00);

    // Re-sync is idempotent: the now-paid statement won't re-match.
    const again = await syncPlaidTransactions(user.id, item.id);
    expect(again.statementsReconciled).toBe(0);
    expect((await getPromo(user.id, promo.id))!.remainingAmountCents).toBe(600_00);
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
    const today = todayIso(DEFAULT_TIMEZONE);
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

  it("backfills a NEGATIVE 'Payment Thank You' draft synced before detection existed", async () => {
    // The real ****9873 shape: the payment posted on the credit account as a
    // negative LOAN_DISBURSEMENTS "Payment Thank You", was stored as `expense`
    // by the old classifier, and never reconciled. A later sync (empty delta)
    // must catch it up via the backfill.
    const user = await makeUser();
    const token = encryptToken("access-token");
    const item = await createPlaidItem(user.id, {
      institutionId: "ins_boa",
      institutionName: "BofA",
      accessTokenEnc: token.enc,
      accessTokenIv: token.iv,
      accessTokenTag: token.tag,
      cursor: "old-cursor",
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: "acct_visa",
      itemId: item.id,
      userId: user.id,
      name: "CREDIT CARD",
      mask: "9873",
      type: "credit",
      subtype: "credit card",
      balanceCents: 505_10,
      updatedAt: Date.now(),
    });
    const card = await createCreditCard(user.id, {
      name: "CREDIT CARD ****9873",
      statementDay: 30,
      dueDay: 26,
      autoPay: true,
      isActive: true,
    });
    await setCreditCardPlaidLink(user.id, card.id, "acct_visa");
    const today = todayIso(DEFAULT_TIMEZONE);
    const statement = await createStatement(card.id, {
      statementDate: addDaysIso(today, -26),
      dueDate: today,
      statementBalanceCents: 380_75,
      minimumPaymentCents: null,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });
    // Pre-existing approved draft, misclassified as expense, negative amount.
    await upsertPlaidDraft({
      id: "pay_neg",
      userId: user.id,
      accountId: "acct_visa",
      date: today,
      description: "Payment Thank You - Web",
      originalDescription: "Payment Thank You - Web",
      amountCents: -380_75,
      plaidCategory: "LOAN_DISBURSEMENTS",
      merchantName: null,
      pending: false,
      status: "approved",
      kind: "expense",
      linkedExpenseId: null,
      linkedPromoId: null,
    });

    __plaidMock.transactionsSync.mockResolvedValue({
      data: { next_cursor: "old-cursor", has_more: false, accounts: [], added: [], modified: [], removed: [] },
    });
    __plaidMock.liabilitiesGet.mockResolvedValue({ data: { liabilities: { credit: [] } } });

    const result = await syncPlaidTransactions(user.id, item.id);
    expect(result.statementsReconciled).toBe(1);

    const settled = (await listStatements(card.id)).find((s) => s.id === statement.id)!;
    expect(settled.paidAmountCents).toBe(380_75); // magnitude of the negative payment
    expect(settled.paidDate).toBe(today);
    // Draft kind corrected so it stops counting as spend.
    expect((await getPlaidDraft(user.id, "pay_neg"))!.kind).toBe("card_payment");

    // Idempotent: a second sync settles nothing more.
    const again = await syncPlaidTransactions(user.id, item.id);
    expect(again.statementsReconciled).toBe(0);
  });

  it("settles a statement from an Interest-Saving-Balance payment on a promo card", async () => {
    // Real Chase 07/10/26 shape: New Balance $1,220.11, four Equal Pay plans
    // totaling $496.01 remaining with $108.16 of plan payments billed this
    // cycle → printed ISB $832.26. Paying the ISB avoids interest, so it must
    // settle the statement even though it's far below the full balance.
    const user = await makeUser();
    const token = encryptToken("access-token");
    const item = await createPlaidItem(user.id, {
      institutionId: "ins_56",
      institutionName: "Chase",
      accessTokenEnc: token.enc,
      accessTokenIv: token.iv,
      accessTokenTag: token.tag,
      cursor: "old-cursor",
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: "acct_prime",
      itemId: item.id,
      userId: user.id,
      name: "CREDIT CARD",
      mask: "9873",
      type: "credit",
      subtype: "credit card",
      balanceCents: 1555_19,
      updatedAt: Date.now(),
    });
    const card = await createCreditCard(user.id, {
      name: "Prime Visa ****9873",
      statementDay: 10,
      dueDay: 7,
      autoPay: false,
      isActive: true,
    });
    await setCreditCardPlaidLink(user.id, card.id, "acct_prime");
    const today = todayIso(DEFAULT_TIMEZONE);
    const statement = await createStatement(card.id, {
      statementDate: addDaysIso(today, -28),
      dueDate: today,
      statementBalanceCents: 1220_11,
      minimumPaymentCents: 143_16,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });
    const plans: Array<[number, number, number]> = [
      // [remaining, monthly plan payment, months until expiration]
      [73_37, 24_46, 3],
      [123_23, 30_82, 4],
      [89_09, 17_82, 5],
      [210_32, 35_06, 6],
    ];
    for (const [remaining, monthly, months] of plans) {
      await createPromo(user.id, card.id, {
        description: `Equal Pay (${monthly})`,
        originalAmountCents: remaining,
        remainingAmountCents: remaining,
        startDate: addDaysIso(today, -60),
        endDate: addMonthsClampedIso(today, months),
        monthlyPaymentCents: monthly,
        notes: null,
        isActive: true,
      });
    }

    __plaidMock.transactionsSync.mockResolvedValue({
      data: {
        next_cursor: "cursor-isb",
        has_more: false,
        accounts: [],
        added: [
          {
            transaction_id: "pay_isb",
            account_id: "acct_prime",
            date: today,
            name: "Payment Thank You - Web",
            amount: -832.26,
            pending: false,
            personal_finance_category: { primary: "LOAN_DISBURSEMENTS", detailed: "" },
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
    expect(settled.paidAmountCents).toBe(832_26);
    expect(settled.paidDate).toBe(today);
    expect(settled.settledByDraftId).toBe("pay_isb");
  });

  it("does not backfill-settle a partial payment on a revolving card", async () => {
    // ****9873 reality: a $219 payment against a $505 statement is partial —
    // it must NOT clear the statement (the balance is still owed).
    const user = await makeUser();
    const token = encryptToken("access-token");
    const item = await createPlaidItem(user.id, {
      institutionId: "ins_boa",
      institutionName: "BofA",
      accessTokenEnc: token.enc,
      accessTokenIv: token.iv,
      accessTokenTag: token.tag,
      cursor: "c",
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: "acct_rev",
      itemId: item.id,
      userId: user.id,
      name: "CREDIT CARD",
      mask: "9873",
      type: "credit",
      subtype: "credit card",
      balanceCents: 1204_76,
      updatedAt: Date.now(),
    });
    const card = await createCreditCard(user.id, {
      name: "CREDIT CARD ****9873",
      statementDay: 30,
      dueDay: 26,
      autoPay: false,
      isActive: true,
    });
    await setCreditCardPlaidLink(user.id, card.id, "acct_rev");
    const today = todayIso(DEFAULT_TIMEZONE);
    await createStatement(card.id, {
      statementDate: addDaysIso(today, -26),
      dueDate: today,
      statementBalanceCents: 505_10,
      minimumPaymentCents: null,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });
    await upsertPlaidDraft({
      id: "pay_partial",
      userId: user.id,
      accountId: "acct_rev",
      date: today,
      description: "Payment Thank You - Web",
      originalDescription: "Payment Thank You - Web",
      amountCents: -219_41,
      plaidCategory: "LOAN_DISBURSEMENTS",
      merchantName: null,
      pending: false,
      status: "approved",
      kind: "expense",
      linkedExpenseId: null,
      linkedPromoId: null,
    });

    __plaidMock.transactionsSync.mockResolvedValue({
      data: { next_cursor: "c", has_more: false, accounts: [], added: [], modified: [], removed: [] },
    });
    __plaidMock.liabilitiesGet.mockResolvedValue({ data: { liabilities: { credit: [] } } });

    const result = await syncPlaidTransactions(user.id, item.id);
    expect(result.statementsReconciled).toBe(0);
    expect((await listStatements(card.id))[0]!.paidAmountCents).toBeNull();
    // But the draft is still reclassified so it stops looking like spend.
    expect((await getPlaidDraft(user.id, "pay_partial"))!.kind).toBe("card_payment");
  });

  it("does not settle a near-full partial payment ($460 against a $505.10 statement)", async () => {
    // Regression for a too-loose match tolerance: 10%-of-payment tolerance
    // used to let a $460 payment "settle" a $505.10 statement, silently
    // dropping the $45.10 residual from the projection.
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
      id: "acct_near_full",
      itemId: item.id,
      userId: user.id,
      name: "Sapphire",
      mask: "1111",
      type: "credit",
      subtype: "credit card",
      balanceCents: 505_10,
      updatedAt: Date.now(),
    });
    const card = await createCreditCard(user.id, {
      name: "Sapphire",
      statementDay: 30,
      dueDay: 26,
      autoPay: false,
      isActive: true,
    });
    await setCreditCardPlaidLink(user.id, card.id, "acct_near_full");
    const today = todayIso(DEFAULT_TIMEZONE);
    await createStatement(card.id, {
      statementDate: addDaysIso(today, -26),
      dueDate: today,
      statementBalanceCents: 505_10,
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
            transaction_id: "pay_near_full",
            account_id: "acct_near_full",
            pending: false,
            date: today,
            name: "Autopay Payment",
            original_description: "AUTOPAY PAYMENT",
            amount: 460.0,
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
    expect((await listStatements(card.id))[0]!.paidAmountCents).toBeNull();
  });

  it("does not settle a statement from a payment reversal/return", async () => {
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
      id: "acct_reversal",
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
      autoPay: false,
      isActive: true,
    });
    await setCreditCardPlaidLink(user.id, card.id, "acct_reversal");
    const today = todayIso(DEFAULT_TIMEZONE);
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
            transaction_id: "pay_reversed",
            account_id: "acct_reversal",
            pending: false,
            date: today,
            name: "Payment Returned",
            original_description: "PAYMENT RETURNED - INSUFFICIENT FUNDS",
            amount: -300.0,
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
    expect((await listStatements(card.id))[0]!.paidAmountCents).toBeNull();
  });

  it("cannot double-settle two statements from one payment within the same sync", async () => {
    // Both statements have the same balance and both fall within the match
    // window, so before the settled_by_draft_id gate this single payment
    // could settle the inline reconcile's statement AND then get replayed
    // by the same sync's backfill against the OTHER open statement.
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
      id: "acct_double",
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
    await setCreditCardPlaidLink(user.id, card.id, "acct_double");
    const today = todayIso(DEFAULT_TIMEZONE);
    const statementOlder = await createStatement(card.id, {
      statementDate: addDaysIso(today, -56),
      dueDate: addDaysIso(today, -30),
      statementBalanceCents: 300_00,
      minimumPaymentCents: null,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });
    const statementNewer = await createStatement(card.id, {
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
            transaction_id: "pay_double",
            account_id: "acct_double",
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
    // Exactly one statement settles — never both from a single payment.
    expect(result.statementsReconciled).toBe(1);

    const stmts = await listStatements(card.id);
    const older = stmts.find((s) => s.id === statementOlder.id)!;
    const newer = stmts.find((s) => s.id === statementNewer.id)!;
    // And it must be the CURRENT cycle (due today), stamped with the draft
    // that paid it — a count-only assertion would stay green if the matcher's
    // ordering regressed and settled last month's statement instead.
    expect(newer.paidAmountCents).toBe(300_00);
    expect(newer.settledByDraftId).toBe("pay_double");
    expect(older.paidAmountCents).toBeNull();
    expect(older.settledByDraftId).toBeNull();
  });

  it("a payment whose statement was paid by another path cannot settle the next cycle", async () => {
    // The settle-once gate only records DRAFT-path settlements; statements
    // marked paid manually (or by the Liabilities sync, or restored from a
    // pre-0024 backup) carry no settledByDraftId. The already-accounted
    // heuristic must consume the payment draft against that paid statement
    // instead of letting it "settle" the next cycle of the same amount.
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
      id: "acct_accounted",
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
    await setCreditCardPlaidLink(user.id, card.id, "acct_accounted");
    const today = todayIso(DEFAULT_TIMEZONE);
    // Last cycle: already marked paid WITHOUT a settledByDraftId (manual /
    // Liabilities / pre-0024 provenance), paid by the very payment below.
    const statementPaidElsewhere = await createStatement(card.id, {
      statementDate: addDaysIso(today, -28),
      dueDate: addDaysIso(today, -2),
      statementBalanceCents: 300_00,
      minimumPaymentCents: null,
      paidAmountCents: 300_00,
      paidDate: addDaysIso(today, -2),
      notes: null,
    });
    // Current cycle: same fixed amount, unpaid, due within the match window.
    const statementOpen = await createStatement(card.id, {
      statementDate: addDaysIso(today, -1),
      dueDate: addDaysIso(today, 26),
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
            transaction_id: "pay_accounted",
            account_id: "acct_accounted",
            pending: false,
            date: addDaysIso(today, -2),
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
    expect(result.statementsReconciled).toBe(0);

    const stmts = await listStatements(card.id);
    const paidElsewhere = stmts.find((s) => s.id === statementPaidElsewhere.id)!;
    const open = stmts.find((s) => s.id === statementOpen.id)!;
    // The draft was consumed against the already-paid cycle (stamped for
    // provenance), and the open statement stayed open.
    expect(paidElsewhere.settledByDraftId).toBe("pay_accounted");
    expect(open.paidAmountCents).toBeNull();
    expect(open.settledByDraftId).toBeNull();

    // Idempotent across syncs: the consumed draft never settles the open one.
    const again = await syncPlaidTransactions(user.id, item.id);
    expect(again.statementsReconciled).toBe(0);
    expect(
      (await listStatements(card.id)).find((s) => s.id === statementOpen.id)!.paidAmountCents,
    ).toBeNull();
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

/** Item + depository checking account flagged as the starting-balance source. */
async function seedCheckingAccount(userId: string, accountId = "acct_checking") {
  const token = encryptToken("access-token");
  const item = await createPlaidItem(userId, {
    institutionId: "ins_bank",
    institutionName: "Test Bank",
    accessTokenEnc: token.enc,
    accessTokenIv: token.iv,
    accessTokenTag: token.tag,
    cursor: null,
    lastSyncedAt: null,
    isActive: true,
  });
  await upsertPlaidAccount({
    id: accountId,
    itemId: item.id,
    userId,
    name: "Checking",
    mask: "4242",
    type: "depository",
    subtype: "checking",
    balanceCents: 5_000_00,
    useAsStartingBalance: true,
    updatedAt: Date.now(),
  });
  return { item, accountId };
}

function depositTxn(over: Record<string, unknown> = {}) {
  return {
    transaction_id: "dep_1",
    account_id: "acct_checking",
    pending: false,
    date: todayIso(DEFAULT_TIMEZONE),
    name: "ACME CORP DIRECT DEP",
    original_description: "ACME CORP DIRECT DEP PPD",
    amount: -1950.0, // Plaid: negative = money in
    personal_finance_category: { primary: "INCOME" },
    merchant_name: null,
    ...over,
  };
}

describe("syncPlaidTransactions paycheck reconciliation", () => {
  it("auto-marks a scheduled paycheck received from a matching deposit; re-sync is a no-op", async () => {
    const user = await makeUser();
    const { item } = await seedCheckingAccount(user.id);
    const paycheck = await createPaycheck(user.id, {
      payDate: TODAY,
      amountCents: 2000_00,
      note: null,
    });

    __plaidMock.transactionsSync.mockResolvedValue({
      data: {
        next_cursor: "c1",
        has_more: false,
        accounts: [],
        added: [depositTxn()],
        modified: [],
        removed: [],
      },
    });
    __plaidMock.liabilitiesGet.mockResolvedValue({ data: { liabilities: { credit: [] } } });

    const result = await syncPlaidTransactions(user.id, item.id);
    expect(result.paychecksReconciled).toBe(1);

    const settled = (await getPaycheck(user.id, paycheck.id))!;
    expect(settled.actualReceived).toBe(true);
    expect(settled.actualAmountCents).toBe(1950_00);
    expect(settled.settledByDraftId).toBe("dep_1");
    expect(settled.actualDate).toBe(TODAY);
    // Planned amount is untouched — only the actual is recorded.
    expect(settled.amountCents).toBe(2000_00);

    // Re-sync (same feed) fires nothing: the draft is consumed and the row
    // is already on the received side of the edge.
    const again = await syncPlaidTransactions(user.id, item.id);
    expect(again.paychecksReconciled).toBe(0);
    expect((await getPaycheck(user.id, paycheck.id))!.actualAmountCents).toBe(1950_00);

    // A user adjustment to the recorded actual survives further re-syncs —
    // received rows are never touched again (manual wins).
    await updatePaycheck(user.id, paycheck.id, { actualAmountCents: 1960_00 });
    const third = await syncPlaidTransactions(user.id, item.id);
    expect(third.paychecksReconciled).toBe(0);
    expect((await getPaycheck(user.id, paycheck.id))!.actualAmountCents).toBe(1960_00);
  });

  it("dates the paycheck by the deposit's posting date, not the scheduled payDate", async () => {
    // Payroll landed two days ahead of schedule (early before a weekend). The
    // reconciliation ledger must reflect when the money actually posted, so the
    // settling draft's date is persisted as actualDate rather than payDate.
    const user = await makeUser();
    const { item } = await seedCheckingAccount(user.id);
    const postedEarly = addDaysIso(TODAY, -2);
    const paycheck = await createPaycheck(user.id, {
      payDate: TODAY,
      amountCents: 2000_00,
      note: null,
    });

    __plaidMock.transactionsSync.mockResolvedValue({
      data: {
        next_cursor: "c1",
        has_more: false,
        accounts: [],
        added: [depositTxn({ date: postedEarly })],
        modified: [],
        removed: [],
      },
    });
    __plaidMock.liabilitiesGet.mockResolvedValue({ data: { liabilities: { credit: [] } } });

    const result = await syncPlaidTransactions(user.id, item.id);
    expect(result.paychecksReconciled).toBe(1);

    const settled = (await getPaycheck(user.id, paycheck.id))!;
    expect(settled.actualDate).toBe(postedEarly);
    expect(settled.actualDate).not.toBe(paycheck.payDate);
  });

  it("never overwrites a manually reconciled paycheck", async () => {
    const user = await makeUser();
    const { item } = await seedCheckingAccount(user.id);
    const paycheck = await createPaycheck(user.id, {
      payDate: TODAY,
      amountCents: 2000_00,
      note: null,
      actualReceived: true,
      actualAmountCents: 2000_00, // user reconciled by hand before the sync ran
    });

    __plaidMock.transactionsSync.mockResolvedValue({
      data: {
        next_cursor: "c1",
        has_more: false,
        accounts: [],
        added: [depositTxn()],
        modified: [],
        removed: [],
      },
    });
    __plaidMock.liabilitiesGet.mockResolvedValue({ data: { liabilities: { credit: [] } } });

    const result = await syncPlaidTransactions(user.id, item.id);
    expect(result.paychecksReconciled).toBe(0);

    const row = (await getPaycheck(user.id, paycheck.id))!;
    expect(row.actualAmountCents).toBe(2000_00);
    expect(row.settledByDraftId).toBeNull(); // still manual, no AUTO provenance
  });

  it("one deposit settles at most one of two same-day paychecks, ever", async () => {
    const user = await makeUser();
    const { item } = await seedCheckingAccount(user.id);
    const a = await createPaycheck(user.id, { payDate: TODAY, amountCents: 2000_00, note: null });
    const b = await createPaycheck(user.id, { payDate: TODAY, amountCents: 2000_00, note: null });

    __plaidMock.transactionsSync.mockResolvedValue({
      data: {
        next_cursor: "c1",
        has_more: false,
        accounts: [],
        added: [depositTxn()],
        modified: [],
        removed: [],
      },
    });
    __plaidMock.liabilitiesGet.mockResolvedValue({ data: { liabilities: { credit: [] } } });

    const result = await syncPlaidTransactions(user.id, item.id);
    expect(result.paychecksReconciled).toBe(1);

    const rows = [(await getPaycheck(user.id, a.id))!, (await getPaycheck(user.id, b.id))!];
    expect(rows.filter((r) => r.actualReceived)).toHaveLength(1);

    // The consumed draft can't settle the second paycheck on a later sync.
    const again = await syncPlaidTransactions(user.id, item.id);
    expect(again.paychecksReconciled).toBe(0);
    expect(
      [(await getPaycheck(user.id, a.id))!, (await getPaycheck(user.id, b.id))!].filter(
        (r) => r.actualReceived,
      ),
    ).toHaveLength(1);
  });

  it("splits two same-day earners' deposits by best amount fit", async () => {
    const user = await makeUser();
    const { item } = await seedCheckingAccount(user.id);
    const mine = await createPaycheck(user.id, { payDate: TODAY, amountCents: 2000_00, note: null });
    const spouse = await createPaycheck(user.id, { payDate: TODAY, amountCents: 1200_00, note: null });

    __plaidMock.transactionsSync.mockResolvedValue({
      data: {
        next_cursor: "c1",
        has_more: false,
        accounts: [],
        added: [
          depositTxn({ transaction_id: "dep_big", amount: -2010.0 }),
          depositTxn({ transaction_id: "dep_small", name: "ZORP LLC PAYROLL", amount: -1180.0 }),
        ],
        modified: [],
        removed: [],
      },
    });
    __plaidMock.liabilitiesGet.mockResolvedValue({ data: { liabilities: { credit: [] } } });

    const result = await syncPlaidTransactions(user.id, item.id);
    expect(result.paychecksReconciled).toBe(2);

    const mineRow = (await getPaycheck(user.id, mine.id))!;
    const spouseRow = (await getPaycheck(user.id, spouse.id))!;
    expect(mineRow.settledByDraftId).toBe("dep_big");
    expect(mineRow.actualAmountCents).toBe(2010_00);
    expect(spouseRow.settledByDraftId).toBe("dep_small");
    expect(spouseRow.actualAmountCents).toBe(1180_00);
  });

  it("un-marking received releases the draft so a later sync can re-settle", async () => {
    const user = await makeUser();
    const { item } = await seedCheckingAccount(user.id);
    const paycheck = await createPaycheck(user.id, {
      payDate: TODAY,
      amountCents: 2000_00,
      note: null,
    });

    __plaidMock.transactionsSync.mockResolvedValue({
      data: {
        next_cursor: "c1",
        has_more: false,
        accounts: [],
        added: [depositTxn()],
        modified: [],
        removed: [],
      },
    });
    __plaidMock.liabilitiesGet.mockResolvedValue({ data: { liabilities: { credit: [] } } });

    await syncPlaidTransactions(user.id, item.id);
    expect((await getPaycheck(user.id, paycheck.id))!.settledByDraftId).toBe("dep_1");

    // The PATCH route clears settledByDraftId whenever received flips off —
    // same release contract as the statements route.
    await updatePaycheck(user.id, paycheck.id, {
      actualReceived: false,
      actualAmountCents: null,
      settledByDraftId: null,
    });

    const result = await syncPlaidTransactions(user.id, item.id);
    expect(result.paychecksReconciled).toBe(1);
    expect((await getPaycheck(user.id, paycheck.id))!.settledByDraftId).toBe("dep_1");
  });

  it("ignores deposits on accounts that do not feed the starting balance", async () => {
    const user = await makeUser();
    const token = encryptToken("access-token");
    const item = await createPlaidItem(user.id, {
      institutionId: "ins_bank",
      institutionName: "Test Bank",
      accessTokenEnc: token.enc,
      accessTokenIv: token.iv,
      accessTokenTag: token.tag,
      cursor: null,
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: "acct_savings",
      itemId: item.id,
      userId: user.id,
      name: "Savings",
      mask: "9999",
      type: "depository",
      subtype: "savings",
      balanceCents: 10_000_00,
      useAsStartingBalance: false,
      updatedAt: Date.now(),
    });
    const paycheck = await createPaycheck(user.id, {
      payDate: TODAY,
      amountCents: 2000_00,
      note: null,
    });

    __plaidMock.transactionsSync.mockResolvedValue({
      data: {
        next_cursor: "c1",
        has_more: false,
        accounts: [],
        added: [depositTxn({ account_id: "acct_savings" })],
        modified: [],
        removed: [],
      },
    });
    __plaidMock.liabilitiesGet.mockResolvedValue({ data: { liabilities: { credit: [] } } });

    const result = await syncPlaidTransactions(user.id, item.id);
    expect(result.paychecksReconciled).toBe(0);
    expect((await getPaycheck(user.id, paycheck.id))!.actualReceived).toBe(false);
  });
});

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
  it("tracks the linked balance and infers an interval cycle from payment transactions", async () => {
    const user = await makeUser();
    const { item, card, plaidAccountId } = await seedLinkedCard(user.id);
    await upsertPlaidAccount({
      id: plaidAccountId,
      itemId: item.id,
      userId: user.id,
      name: "Test Credit",
      mask: "1234",
      type: "credit",
      subtype: "credit card",
      balanceCents: 987_65,
      updatedAt: Date.now(),
    });
    for (const [id, date] of [
      ["payment-1", "2025-01-05"],
      ["payment-2", "2025-02-04"],
      ["payment-3", "2025-03-06"],
    ] as const) {
      await upsertPlaidDraft({
        id,
        userId: user.id,
        accountId: plaidAccountId,
        date,
        description: "CARD PAYMENT",
        originalDescription: null,
        amountCents: -100_00,
        plaidCategory: "LOAN_PAYMENTS",
        merchantName: null,
        pending: false,
        status: "approved",
        kind: "card_payment",
        linkedExpenseId: null,
        linkedPromoId: null,
      });
    }
    __plaidMock.liabilitiesGet.mockResolvedValue({
      data: {
        liabilities: {
          credit: [
            {
              account_id: plaidAccountId,
              last_statement_issue_date: "2025-03-15",
              next_payment_due_date: "2025-04-05",
              last_statement_balance: 500,
            },
          ],
        },
      },
    });

    await syncCreditCardLiabilitiesForItem(user.id, item.id, "tok");

    expect(await getCreditCard(user.id, card.id)).toMatchObject({
      currentBalanceCents: 987_65,
      statementCycleMode: "interval_days",
      statementCycleAnchorDate: "2025-03-15",
      statementCycleIntervalDays: 30,
    });
  });

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

describe("credit-line refresh (the migration-0034 regression)", () => {
  /**
   * Shipped bug: the seeding code lived inside the transactions/sync pagination
   * loop, reading `data.accounts`. That payload is frequently absent, and even
   * when present its balances carry no `limit` — so no card ever got a credit
   * line. Limits now come from /accounts/get, outside that loop.
   */
  /**
   * `seedLinkedCard` stores a dummy access token, which is fine for the callers
   * that invoke the liabilities helper directly — but `syncPlaidTransactions`
   * decrypts first, and would abort the item before ever reaching the refresh.
   */
  async function seedLinkedCardForSync(userId: string, plaidAccountId = "acct_cc") {
    const token = encryptToken("access-token");
    const item = await createPlaidItem(userId, {
      institutionId: "ins",
      institutionName: "Test Bank",
      accessTokenEnc: token.enc,
      accessTokenIv: token.iv,
      accessTokenTag: token.tag,
      cursor: null,
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: plaidAccountId,
      itemId: item.id,
      userId,
      name: "Test Credit",
      mask: "1234",
      type: "credit",
      subtype: "credit card",
      balanceCents: 50_00,
      updatedAt: Date.now(),
    });
    const card = await createCreditCard(userId, {
      name: "My Card",
      statementDay: 1,
      dueDay: 21,
      autoPay: false,
      isActive: true,
    });
    await setCreditCardPlaidLink(userId, card.id, plaidAccountId);
    return { item, card, plaidAccountId };
  }

  function syncReturningNoAccounts() {
    __plaidMock.transactionsSync.mockResolvedValue({
      data: { added: [], modified: [], removed: [], next_cursor: "c1", has_more: false },
    });
    __plaidMock.liabilitiesGet.mockResolvedValue({ data: { liabilities: { credit: [] } } });
  }

  function accountsGetReturning(limit: number | null, accountId = "acct_cc") {
    __plaidMock.accountsGet.mockResolvedValue({
      data: {
        accounts: [
          {
            account_id: accountId,
            name: "Test Credit",
            mask: "1234",
            type: "credit",
            subtype: "credit card",
            balances: { current: 400.0, limit },
          },
        ],
      },
    });
  }

  it("seeds a linked card's credit line even when transactions/sync returns no accounts", async () => {
    const user = await makeUser();
    const { card } = await seedLinkedCardForSync(user.id);
    syncReturningNoAccounts();
    accountsGetReturning(1_000.0);

    await syncPlaidTransactions(user.id);

    const after = await getCreditCard(user.id, card.id);
    expect(after?.creditLimitCents).toBe(100_000);
  });

  it("never overwrites a credit line the user set by hand", async () => {
    const user = await makeUser();
    const { card } = await seedLinkedCardForSync(user.id);
    await updateCreditCard(user.id, card.id, { creditLimitCents: 250_000 });
    syncReturningNoAccounts();
    accountsGetReturning(1_000.0);

    await syncPlaidTransactions(user.id);

    const after = await getCreditCard(user.id, card.id);
    expect(after?.creditLimitCents).toBe(250_000);
  });

  it("keeps a known account limit when a later payload reports none", async () => {
    const user = await makeUser();
    const { card } = await seedLinkedCardForSync(user.id);
    syncReturningNoAccounts();
    accountsGetReturning(1_000.0);
    await syncPlaidTransactions(user.id);

    // Second sync: this issuer stops reporting a limit. The stored value must
    // survive — a null must never erase what we already know.
    accountsGetReturning(null);
    await syncPlaidTransactions(user.id);

    const accounts = await listPlaidAccounts(user.id);
    expect(accounts.find((a) => a.id === "acct_cc")?.limitCents).toBe(100_000);
    const after = await getCreditCard(user.id, card.id);
    expect(after?.creditLimitCents).toBe(100_000);
  });

  it("treats an accounts/get failure as non-fatal", async () => {
    const user = await makeUser();
    const { card } = await seedLinkedCardForSync(user.id);
    syncReturningNoAccounts();
    __plaidMock.accountsGet.mockRejectedValue(new Error("PRODUCT_NOT_READY"));

    await expect(syncPlaidTransactions(user.id)).resolves.toBeTruthy();
    const after = await getCreditCard(user.id, card.id);
    expect(after?.creditLimitCents).toBeNull();
  });
});

describe("live balance refresh (the stale-cache regression)", () => {
  /**
   * Shipped bug, measured on Alliant Credit Union 2026-08-11: both
   * /transactions/sync's `data.accounts` and /accounts/get return Plaid's
   * CACHED balance. Alliant's cache ran ~a day behind, so the account
   * anchoring the whole projection read $667.79 against a live $400.05 — a
   * $267 error in the overdraft direction, with no pending float to explain it
   * (Alliant reports available == current and no pending transactions).
   * /accounts/balance/get is the only endpoint that pulls live.
   */
  async function seedCheckingItem(
    userId: string,
    opts: { useAsStartingBalance?: boolean; type?: string; cachedCents?: number } = {},
  ) {
    const token = encryptToken("access-token");
    const item = await createPlaidItem(userId, {
      institutionId: "ins_116282",
      institutionName: "Alliant Credit Union",
      accessTokenEnc: token.enc,
      accessTokenIv: token.iv,
      accessTokenTag: token.tag,
      cursor: null,
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: "acct_chk",
      itemId: item.id,
      userId,
      name: "Checking",
      mask: "2677",
      type: opts.type ?? "depository",
      subtype: "checking",
      balanceCents: opts.cachedCents ?? 667_79,
      availableBalanceCents: opts.cachedCents ?? 667_79,
      useAsStartingBalance: opts.useAsStartingBalance ?? true,
      updatedAt: Date.now(),
    });
    return item;
  }

  function syncReturningNoAccounts() {
    __plaidMock.transactionsSync.mockResolvedValue({
      data: { added: [], modified: [], removed: [], next_cursor: "c1", has_more: false },
    });
    __plaidMock.liabilitiesGet.mockResolvedValue({ data: { liabilities: { credit: [] } } });
  }

  /** The cached path reports the STALE figure, exactly like Alliant did. */
  function accountsGetReturningStale(cents = 667.79) {
    __plaidMock.accountsGet.mockResolvedValue({
      data: {
        accounts: [
          {
            account_id: "acct_chk",
            name: "Checking",
            mask: "2677",
            type: "depository",
            subtype: "checking",
            balances: { current: cents, available: cents, limit: null },
          },
        ],
      },
    });
  }

  function balanceGetReturning(current: number | null, available: number | null = current) {
    __plaidMock.accountsBalanceGet.mockResolvedValue({
      data: {
        accounts: [
          {
            account_id: "acct_chk",
            name: "Checking",
            mask: "2677",
            type: "depository",
            subtype: "checking",
            balances: { current, available, limit: null },
          },
        ],
      },
    });
  }

  async function storedBalance(userId: string) {
    const accounts = await listPlaidAccounts(userId);
    return accounts.find((a) => a.id === "acct_chk");
  }

  it("overwrites the cached balance with the live one", async () => {
    const user = await makeUser();
    await seedCheckingItem(user.id);
    syncReturningNoAccounts();
    accountsGetReturningStale();
    balanceGetReturning(400.05);

    const res = await syncPlaidTransactions(user.id);

    // The live figure must win — it runs strictly after the cached refresh.
    expect((await storedBalance(user.id))?.balanceCents).toBe(400_05);
    expect(res.liveBalancesRefreshed).toBe(1);
  });

  it("scopes the paid call to the anchored accounts only", async () => {
    const user = await makeUser();
    await seedCheckingItem(user.id);
    syncReturningNoAccounts();
    accountsGetReturningStale();
    balanceGetReturning(400.05);

    await syncPlaidTransactions(user.id);

    expect(__plaidMock.accountsBalanceGet).toHaveBeenCalledTimes(1);
    expect(__plaidMock.accountsBalanceGet).toHaveBeenCalledWith(
      expect.objectContaining({ options: { account_ids: ["acct_chk"] } }),
    );
  });

  it("never calls the paid endpoint when no account anchors the projection", async () => {
    const user = await makeUser();
    await seedCheckingItem(user.id, { useAsStartingBalance: false });
    syncReturningNoAccounts();
    accountsGetReturningStale();

    await syncPlaidTransactions(user.id);

    expect(__plaidMock.accountsBalanceGet).not.toHaveBeenCalled();
  });

  it("never calls the paid endpoint for a credit account", async () => {
    const user = await makeUser();
    // A credit balance is a debt figure, never a starting balance — even if
    // something flagged it, it must not justify a billed call. No accountsGet
    // payload here on purpose: Plaid is authoritative for account type, so a
    // depository payload would (correctly) overwrite the seeded type.
    await seedCheckingItem(user.id, { type: "credit" });
    syncReturningNoAccounts();

    await syncPlaidTransactions(user.id);

    expect(__plaidMock.accountsBalanceGet).not.toHaveBeenCalled();
  });

  it("throttles repeat pulls inside the interval", async () => {
    const user = await makeUser();
    const item = await seedCheckingItem(user.id);
    balanceGetReturning(400.05);
    const now = 1_800_000_000_000;

    const res = await refreshLiveBalancesForItem(
      user.id,
      item.id,
      "access-token",
      now - (BALANCE_REFRESH_MIN_INTERVAL_MS - 1),
      now,
    );

    expect(res.skipped).toBe("throttled");
    expect(__plaidMock.accountsBalanceGet).not.toHaveBeenCalled();
  });

  it("pulls again once the interval has elapsed", async () => {
    const user = await makeUser();
    const item = await seedCheckingItem(user.id);
    balanceGetReturning(400.05);
    const now = 1_800_000_000_000;

    const res = await refreshLiveBalancesForItem(
      user.id,
      item.id,
      "access-token",
      now - BALANCE_REFRESH_MIN_INTERVAL_MS,
      now,
    );

    expect(res.skipped).toBeNull();
    expect(res.accountsRefreshed).toBe(1);
    expect((await storedBalance(user.id))?.balanceCents).toBe(400_05);
  });

  it("keeps the cached balance when the live pull is rate limited, and backs off", async () => {
    const user = await makeUser();
    const item = await seedCheckingItem(user.id);
    // Plaid throws axios errors; the code lives in the response body.
    __plaidMock.accountsBalanceGet.mockRejectedValue({
      response: { data: { error_code: "BALANCE_LIMIT" } },
      message: "Request failed with status code 429",
    });
    const now = 1_800_000_000_000;

    const res = await refreshLiveBalancesForItem(user.id, item.id, "access-token", null, now);

    expect(res.accountsRefreshed).toBe(0);
    expect((await storedBalance(user.id))?.balanceCents).toBe(667_79);
    // Stamped despite the failure, so a rate-limited item isn't retried on
    // every sync — the next attempt is throttled.
    const after = await refreshLiveBalancesForItem(
      user.id,
      item.id,
      "access-token",
      now,
      now + 1_000,
    );
    expect(after.skipped).toBe("throttled");
  });

  it("keeps the cached balance when the live payload reports no current", async () => {
    const user = await makeUser();
    const item = await seedCheckingItem(user.id);
    balanceGetReturning(null, null);

    const res = await refreshLiveBalancesForItem(user.id, item.id, "access-token", null, 1);

    expect(res.accountsRefreshed).toBe(0);
    // Writing the null would have erased a balance we already had.
    expect((await storedBalance(user.id))?.balanceCents).toBe(667_79);
  });

  it("writes current and available from the same live payload", async () => {
    const user = await makeUser();
    const item = await seedCheckingItem(user.id);
    balanceGetReturning(400.05, 350.0);

    await refreshLiveBalancesForItem(user.id, item.id, "access-token", null, 1);

    // Both halves live as of the same instant — the float is real, not an
    // artifact of a fresh current against a stale available.
    const acct = await storedBalance(user.id);
    expect(acct?.balanceCents).toBe(400_05);
    expect(acct?.availableBalanceCents).toBe(350_00);
  });
});
