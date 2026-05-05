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
  upsertCreditCardPaymentOverride,
  upsertPlaidAccount,
  updatePlaidAccount,
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

  it("shows past autopay bills as paid without replaying them against the live balance", async () => {
    const user = await makeUser();
    await seedLinkedStartingBalance(user.id, 500_00);
    await createBill(user.id, {
      name: "Blue Falls",
      category: "Housing",
      amountCents: 4400_00,
      intervalMonths: 1,
      anchorDate: "2026-05-03",
      autoPay: true,
      paidViaCardId: null,
      notes: null,
      isActive: true,
    });

    const projection = await buildProjection(user.id);
    const paidDay = projection?.rows.find((r) => r.date === "2026-05-03");

    expect(projection?.startDate).toBe("2026-05-01");
    expect(projection?.startingBalanceCents).toBe(500_00);
    expect(paidDay?.expenseCents).toBe(0);
    expect(paidDay?.balanceCents).toBe(500_00);
    expect(paidDay?.events).toEqual([
      expect.objectContaining({
        label: "Blue Falls",
        amountCents: 0,
        originalAmountCents: 4400_00,
        isPaid: true,
      }),
    ]);
  });
});
