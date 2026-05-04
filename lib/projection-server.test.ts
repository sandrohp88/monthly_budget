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
  createCreditCard,
  createPromo,
  createStatement,
  upsertCreditCardPaymentOverride,
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

async function seedPromoProjection(statementBalanceCents: number) {
  const user = await makeUser();
  const card = await createCreditCard(user.id, {
    name: "PayPal",
    statementDay: 15,
    dueDay: 10,
    autoPay: false,
    isActive: true,
  });
  await createStatement(card.id, {
    statementDate: "2026-05-15",
    dueDate: "2026-06-10",
    statementBalanceCents,
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

  const projection = await buildProjection(user.id);
  return projection?.rows.find((r) => r.date === "2026-06-10");
}

describe("buildProjection promo statement reconciliation", () => {
  it("keeps a desired promo payment in the current cycle when the statement due amount is zero", async () => {
    const row = await seedPromoProjection(0);
    expect(row?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "extra",
          label: "PayPal promo payment",
          amountCents: 125_00,
        }),
      ]),
    );
  });

  it("does not double-count a promo payment when a positive statement already covers the cycle", async () => {
    const row = await seedPromoProjection(125_00);
    expect(
      row?.events.some((event) => event.label === "PayPal promo payment"),
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

  it("can move a promo payment into a different planned date", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "PayPal",
      statementDay: 15,
      dueDay: 10,
      autoPay: false,
      isActive: true,
    });
    await createStatement(card.id, {
      statementDate: "2026-05-15",
      dueDate: "2026-06-10",
      statementBalanceCents: 0,
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
      amountCents: 0,
      notes: "moved-to:2026-06-01",
    });
    await upsertCreditCardPaymentOverride(user.id, card.id, {
      dueDate: "2026-06-01",
      amountCents: 125_00,
      notes: "moved-from:2026-06-10",
    });

    const projection = await buildProjection(user.id);
    const plannedRow = projection?.rows.find((r) => r.date === "2026-06-01");
    const originalRow = projection?.rows.find((r) => r.date === "2026-06-10");

    expect(plannedRow?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "PayPal planned payment",
          amountCents: 125_00,
          relatedDate: "2026-06-10",
        }),
      ]),
    );
    expect(
      originalRow?.events.some((event) => event.label === "PayPal promo payment"),
    ).toBe(false);
  });
});
