import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

vi.mock("server-only", () => ({}));

vi.mock("./auth", () => ({
  hashPassword: async (p: string) => `mock-hash-${p}`,
}));

vi.mock("./dates", async (importActual) => {
  const actual = await importActual<typeof import("./dates")>();
  return {
    ...actual,
    todayIso: () => "2026-05-04",
  };
});

import { __resetDbCacheForTests, getDb, runMigrations } from "./db/client";
import { settings, users } from "./db/schema";
import { newId } from "./ids";
import { buildProjection } from "./projection-server";
import {
  createBill,
  createCreditCard,
  createPlaidItem,
  createPromo,
  createStatement,
  updateSettings,
  upsertCreditCardPaymentOverride,
  upsertPlaidAccount,
  updatePlaidAccount,
  upsertPlaidDraft,
} from "./repos";

let dbDir: string;

beforeEach(() => {
  __resetDbCacheForTests();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-projection-server-"));
  process.env.DATABASE_URL = `file:${path.join(dbDir, "test.db")}`;
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

async function makeUser(): Promise<{ id: string }> {
  const db = getDb();
  const id = newId();
  await db
    .insert(users)
    .values({
      id,
      email: "projection@example.com",
      passwordHash: "x".repeat(64),
      displayName: "Projection Tester",
      role: "admin",
    })
    .run();
  await db
    .insert(settings)
    .values({
      id: newId(),
      userId: id,
      startingBalanceCents: 1_000_00,
      defaultPaycheckCents: 0,
      firstPaydayDate: "2026-05-08",
      payFrequencyDays: 14,
      projectionMonths: 2,
      currency: "USD",
      timezone: "America/Los_Angeles",
    })
    .run();
  return { id };
}

async function seedPromoProjection(statementBalanceCents: number | null) {
  const user = await makeUser();
  const card = await createCreditCard(user.id, {
    name: "PayPal",
    statementDay: 15,
    dueDay: 10,
    currentBalanceCents: 1_000_00,
    autoPay: false,
    isActive: true,
  });
  if (statementBalanceCents !== null) {
    await createStatement(card.id, {
      statementDate: "2026-05-15",
      dueDate: "2026-06-10",
      statementBalanceCents,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });
  }
  await createPromo(user.id, card.id, {
    description: "0% APR purchase",
    originalAmountCents: 1_000_00,
    remainingAmountCents: 1_000_00,
    startDate: "2026-05-01",
    endDate: "2026-12-31",
    monthlyPaymentCents: 125_00,
    notes: null,
    isActive: true,
  });

  const projection = await buildProjection(user.id);
  return projection?.rows.find((r) => r.date === "2026-06-10");
}

describe("buildProjection promo statement reconciliation", () => {
  it("does not project a promo payment when the statement due amount is zero", async () => {
    const row = await seedPromoProjection(0);
    expect(row?.events.some((event) => event.label === "PayPal promo (0% APR purchase)")).toBe(false);
  });

  it("does not double-count a promo payment when a positive statement already covers the cycle", async () => {
    const row = await seedPromoProjection(125_00);
    expect(
      row?.events.some((event) => event.label === "PayPal promo (0% APR purchase)"),
    ).toBe(false);
    expect(row?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "PayPal payment",
          amountCents: 125_00,
        }),
      ]),
    );
  });

  it("projects only the unpaid portion of a partially-paid statement", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Partial Card",
      statementDay: 15,
      dueDay: 10,
      currentBalanceCents: 300_00,
      autoPay: false,
      isActive: true,
    });
    await createStatement(card.id, {
      statementDate: "2026-05-15",
      dueDate: "2026-06-10",
      statementBalanceCents: 200_00,
      paidAmountCents: 50_00,
      paidDate: "2026-06-01",
      notes: null,
    });

    const projection = await buildProjection(user.id);
    const event = projection?.rows
      .find((r) => r.date === "2026-06-10")
      ?.events.find((e) => e.label === "Partial Card payment");

    expect(event).toMatchObject({
      amountCents: 150_00,
      originalAmountCents: 150_00,
      paymentDueCents: 150_00,
    });
  });

  it("projects a Plaid minimum payment when PayPal reports a zero statement balance", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "PayPal",
      statementDay: 15,
      dueDay: 10,
      currentBalanceCents: 900_00,
      autoPay: false,
      isActive: true,
    });
    await createStatement(card.id, {
      statementDate: "2026-05-15",
      dueDate: "2026-06-10",
      statementBalanceCents: 0,
      minimumPaymentCents: 35_00,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });

    const projection = await buildProjection(user.id);
    const event = projection?.rows
      .find((r) => r.date === "2026-06-10")
      ?.events.find((e) => e.label === "PayPal payment");

    expect(event).toMatchObject({
      amountCents: 35_00,
      originalAmountCents: 35_00,
      paymentDueCents: 35_00,
      paymentBalanceCents: 900_00,
    });
  });

  it("uses the full statement balance when Plaid also returns a lower minimum payment", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Rewards Card",
      statementDay: 15,
      dueDay: 10,
      currentBalanceCents: 500_00,
      autoPay: false,
      isActive: true,
    });
    await createStatement(card.id, {
      statementDate: "2026-05-15",
      dueDate: "2026-06-10",
      statementBalanceCents: 200_00,
      minimumPaymentCents: 35_00,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });

    const projection = await buildProjection(user.id);
    const event = projection?.rows
      .find((r) => r.date === "2026-06-10")
      ?.events.find((e) => e.label === "Rewards Card payment");

    expect(event).toMatchObject({
      amountCents: 200_00,
      originalAmountCents: 200_00,
      paymentDueCents: 200_00,
    });
  });

  it("does not double-count a promo when paidAmountCents is zero on an unpaid statement", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "PayPal",
      statementDay: 15,
      dueDay: 10,
      currentBalanceCents: 1_000_00,
      autoPay: false,
      isActive: true,
    });
    await createStatement(card.id, {
      statementDate: "2026-05-15",
      dueDate: "2026-06-10",
      statementBalanceCents: 125_00,
      paidAmountCents: 0,
      paidDate: null,
      notes: null,
    });
    await createPromo(user.id, card.id, {
      description: "0% APR purchase",
      originalAmountCents: 1_000_00,
      remainingAmountCents: 1_000_00,
      startDate: "2026-05-01",
      endDate: "2026-12-31",
      monthlyPaymentCents: 125_00,
      notes: null,
      isActive: true,
    });

    const row = (await buildProjection(user.id))?.rows.find((r) => r.date === "2026-06-10");

    expect(row?.events.some((event) => event.label === "PayPal promo (0% APR purchase)")).toBe(false);
    expect(row?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "PayPal payment",
          amountCents: 125_00,
        }),
      ]),
    );
  });

  it("carries card balance and amount-due metadata on promo projection rows", async () => {
    const row = await seedPromoProjection(null);
    expect(row?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "PayPal promo (0% APR purchase)",
          amountCents: 125_00,
          originalAmountCents: 125_00,
          paymentDueCents: 125_00,
          paymentBalanceCents: 875_00,
        }),
      ]),
    );
  });

  it("allows a planned card payment above the statement due amount", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "PayPal",
      statementDay: 15,
      dueDay: 10,
      currentBalanceCents: 1_000_00,
      autoPay: false,
      isActive: true,
    });
    await createStatement(card.id, {
      statementDate: "2026-05-15",
      dueDate: "2026-06-10",
      statementBalanceCents: 125_00,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });
    await createPromo(user.id, card.id, {
      description: "0% APR purchase",
      originalAmountCents: 1_000_00,
      remainingAmountCents: 1_000_00,
      startDate: "2026-05-01",
      endDate: "2026-12-31",
      monthlyPaymentCents: 125_00,
      notes: null,
      isActive: true,
    });
    await upsertCreditCardPaymentOverride(user.id, card.id, {
      dueDate: "2026-06-10",
      amountCents: 300_00,
      notes: null,
    });

    const projection = await buildProjection(user.id);
    const event = projection?.rows
      .find((r) => r.date === "2026-06-10")
      ?.events.find((e) => e.label === "PayPal payment");

    expect(event).toMatchObject({
      amountCents: 300_00,
      originalAmountCents: 125_00,
      paymentDueCents: 125_00,
      paymentBalanceCents: 1_000_00,
    });
  });

  it("deduplicates duplicate statement rows for the same card due date", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Shifted Statement Card",
      statementDay: 10,
      dueDay: 7,
      currentBalanceCents: 380_75,
      autoPay: false,
      isActive: true,
    });
    await createStatement(card.id, {
      statementDate: "2026-04-10",
      dueDate: "2026-05-07",
      statementBalanceCents: 653_13,
      paidAmountCents: 530_84,
      paidDate: "2026-04-20",
      notes: null,
    });
    await createStatement(card.id, {
      statementDate: "2026-04-19",
      dueDate: "2026-05-07",
      statementBalanceCents: 653_13,
      paidAmountCents: 530_84,
      paidDate: "2026-05-02",
      notes: null,
    });

    const row = (await buildProjection(user.id))?.rows.find((r) => r.date === "2026-05-07");
    const events = row?.events.filter((event) => event.label === "Shifted Statement Card payment");

    expect(events).toHaveLength(1);
    expect(events?.[0]).toMatchObject({
      amountCents: 122_29,
      originalAmountCents: 122_29,
      paymentDueCents: 122_29,
    });
  });
});

describe("buildProjection linked starting balance", () => {
  async function seedLinkedStartingBalance(userId: string, balanceCents: number) {
    const item = await createPlaidItem(userId, {
      institutionId: "ins",
      institutionName: "Bank",
      accessTokenEnc: "00",
      accessTokenIv: "00",
      accessTokenTag: "00",
      cursor: null,
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: "checking",
      itemId: item.id,
      userId,
      name: "Checking",
      mask: "0001",
      type: "depository",
      subtype: "checking",
      balanceCents,
      updatedAt: Date.now(),
    });
    await updatePlaidAccount(userId, "checking", { useAsStartingBalance: true });
  }

  it("anchors on today and skips bills that already happened (their cash is inside the live balance)", async () => {
    // The Plaid balance is current, so a bill that posted before today is
    // already accounted for. Replaying it would double-debit. The projection
    // therefore starts at today and ignores past occurrences entirely.
    const user = await makeUser();
    await seedLinkedStartingBalance(user.id, 500_00);
    await createBill(user.id, {
      name: "Blue Falls",
      category: "Housing",
      amountCents: 4400_00,
      intervalMonths: 1,
      anchorDate: "2026-05-03", // yesterday relative to mocked today=2026-05-04
      autoPay: true,
      paidViaCardId: null,
      notes: null,
      isActive: true,
    });

    const projection = await buildProjection(user.id);

    expect(projection?.startDate).toBe("2026-05-04");
    expect(projection?.startingBalanceCents).toBe(500_00);
    expect(projection?.rows[0]?.date).toBe("2026-05-04");
    expect(projection?.rows[0]?.balanceCents).toBe(500_00);

    // The next month's occurrence (2026-06-03) should still be projected as
    // a normal cash debit — only past occurrences are skipped.
    const nextMonth = projection?.rows.find((r) => r.date === "2026-06-03");
    expect(nextMonth?.expenseCents).toBe(4400_00);
  });

  it("reconstructs past balances from drafts when startingBalanceAsOf is rolled back", async () => {
    // User sets startingBalanceAsOf to 2026-05-01 (3 days before mocked today
    // 2026-05-04). Live linked balance is $500. Two posted drafts in window:
    //   2026-05-02: -$100 (expense)
    //   2026-05-03: +$30 (refund — negative amount = credit)
    // Reconstruction:
    //   end-of 2026-05-03 balance = $500
    //   end-of 2026-05-02 balance = $500 - (-$30) = $530   (refund hadn't landed)
    //   end-of 2026-05-01 balance = $530 - (-$100) = $630  (expense hadn't landed)
    // Forward walk lands at $500 on today.
    const user = await makeUser();
    await seedLinkedStartingBalance(user.id, 500_00);
    await updateSettings(user.id, { startingBalanceAsOf: "2026-05-01" });
    await upsertPlaidDraft({
      id: "txn-1",
      userId: user.id,
      accountId: "checking",
      date: "2026-05-02",
      description: "Coffee",
      originalDescription: null,
      amountCents: 100_00,
      plaidCategory: null,
      merchantName: "Cafe",
      pending: false,
      status: "approved",
      kind: "expense",
      linkedExpenseId: null,
      linkedPromoId: null,
    });
    await upsertPlaidDraft({
      id: "txn-2",
      userId: user.id,
      accountId: "checking",
      date: "2026-05-03",
      description: "Refund",
      originalDescription: null,
      amountCents: -30_00,
      plaidCategory: null,
      merchantName: "Store",
      pending: false,
      status: "approved",
      kind: "expense",
      linkedExpenseId: null,
      linkedPromoId: null,
    });

    const projection = await buildProjection(user.id);

    expect(projection?.startDate).toBe("2026-05-01");
    expect(projection?.startingBalanceCents).toBe(570_00); // 500 + (100 + -30)

    const may1 = projection?.rows.find((r) => r.date === "2026-05-01");
    expect(may1?.balanceCents).toBe(570_00);

    const may2 = projection?.rows.find((r) => r.date === "2026-05-02");
    expect(may2?.expenseCents).toBe(100_00);
    expect(may2?.balanceCents).toBe(470_00);

    const may3 = projection?.rows.find((r) => r.date === "2026-05-03");
    expect(may3?.incomeCents).toBe(30_00); // refund flows to income
    expect(may3?.balanceCents).toBe(500_00);

    const today = projection?.rows.find((r) => r.date === "2026-05-04");
    expect(today?.balanceCents).toBe(500_00);
  });

  it("renders past scheduled bills as paid markers (zero amount, isPaid) in lookback mode", async () => {
    const user = await makeUser();
    await seedLinkedStartingBalance(user.id, 500_00);
    await updateSettings(user.id, { startingBalanceAsOf: "2026-05-01" });
    await createBill(user.id, {
      name: "Blue Falls",
      category: "Housing",
      amountCents: 4400_00,
      intervalMonths: 1,
      anchorDate: "2026-05-03", // before today=2026-05-04
      autoPay: false,
      paidViaCardId: null,
      notes: null,
      isActive: true,
    });

    const projection = await buildProjection(user.id);
    const may3 = projection?.rows.find((r) => r.date === "2026-05-03");
    const billEvent = may3?.events.find((ev) => ev.label === "Blue Falls");

    expect(billEvent).toMatchObject({
      kind: "bill",
      amountCents: 0,
      originalAmountCents: 4400_00,
      isPaid: true,
    });
    // Past occurrence is a marker only — no balance impact.
    expect(may3?.expenseCents).toBe(0);
  });

  it("clamps lookback when startingBalanceAsOf is older than the cap (default 1970-01-01)", async () => {
    // Sanity check on the MAX_LOOKBACK_DAYS clamp: a user who never set the
    // field still gets the linked-no-lookback experience.
    const user = await makeUser();
    await seedLinkedStartingBalance(user.id, 500_00);
    // Default startingBalanceAsOf is 1970-01-01 from the schema.

    const projection = await buildProjection(user.id);
    expect(projection?.startDate).toBe("2026-05-04");
    expect(projection?.startingBalanceCents).toBe(500_00);
    expect(projection?.rows[0]?.date).toBe("2026-05-04");
  });
});
