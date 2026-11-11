import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

vi.mock("./auth", () => ({
  hashPassword: async (p: string) => `mock-hash-${p}`,
}));
vi.mock("server-only", () => ({}));

import { __resetDbCacheForTests, getDb, runMigrations } from "./db/client";
import {
  users,
  settings,
  creditCards,
  bills,
  oneTimeExpenses,
  paychecks,
  creditCardStatements,
  billPaymentOverrides,
  billPaymentStates,
  variableBills,
  variableBillCards,
  creditCardPaymentOverrides,
  categories,
  creditCardPromos,
  creditCardPromoPayments,
  assets,
} from "./db/schema";
import { newId } from "./ids";
import { buildProjection } from "./projection-server";
import { snapshotDir, writePreImportSnapshot } from "./backup-snapshot";
import {
  importAll,
  exportAll,
  previewImport,
  createBill,
  createCreditCard,
  createPlaidItem,
  getCreditCard,
  upsertCreditCardPaymentOverride,
  upsertPlaidAccount,
} from "./repos";
import {
  BACKUP_SCHEMA_VERSION,
  MAX_ABS_CENTS,
  assetCreateSchema,
  backupImportSchema,
  billCreateSchema,
  billPaymentOverrideSchema,
  billPaymentStateSchema,
  cardPaymentOpSchema,
  categoryCreateSchema,
  creditCardCreateSchema,
  creditCardPaymentOverrideSchema,
  extraCreateSchema,
  paycheckCreateSchema,
  paycheckUpdateSchema,
  promoCreateSchema,
  promoPaymentCreateSchema,
  settingsUpdateSchema,
  statementCreateSchema,
  statementUpdateSchema,
  variableBillCreateSchema,
  type BackupImportInput,
} from "./validation";
import { and, eq } from "drizzle-orm";

let dbDir: string;
beforeEach(() => {
  __resetDbCacheForTests();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-import-"));
  process.env.DATABASE_URL = `file:${path.join(dbDir, "test.db")}`;
  getDb();
  runMigrations();
});
afterEach(() => {
  __resetDbCacheForTests();
  try {
    fs.rmSync(dbDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** A minimal valid backup envelope; tests override the collections they need. */
function envelope(partial: Partial<BackupImportInput>): BackupImportInput {
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: "2026-09-21T00:00:00.000Z",
    settings: null,
    bills: [],
    paychecks: [],
    extras: [],
    creditCards: [],
    ...partial,
  };
}

async function makeUser(email: string): Promise<{ id: string }> {
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

describe("backup import / Zod schema rejects malformed payloads", () => {
  it("rejects a bill with a non-numeric amount", () => {
    const result = backupImportSchema.safeParse(
      envelope({ bills: [{ name: "rent", amountCents: "twelve hundred" }] as never }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a date that isn't ISO YYYY-MM-DD", () => {
    const result = backupImportSchema.safeParse(
      envelope({ paychecks: [{ payDate: "06/01/2026", amountCents: 100 }] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects an oversized payload", () => {
    const huge = Array.from({ length: 1001 }, (_, i) => ({
      name: `bill-${i}`,
      amountCents: 100,
      intervalMonths: 1,
      anchorDate: "2026-01-01",
    }));
    const result = backupImportSchema.safeParse(envelope({ bills: huge }));
    expect(result.success).toBe(false);
  });
});

describe("backup import / graph integrity", () => {
  it("rejects a statement that points at a card not in the payload", async () => {
    const user = await makeUser("a@example.com");
    const payload = envelope({
      creditCards: [],
      creditCardStatements: [
        {
          cardId: "ghost-card-id",
          statementDate: "2026-05-01",
          dueDate: "2026-05-25",
          statementBalanceCents: 100,
        },
      ],
    });
    await expect(importAll(user.id, payload)).rejects.toThrow(/unknown cardId/);
  });

  it("rejects a bill payment override that points at a missing bill", async () => {
    const user = await makeUser("a@example.com");
    const payload = envelope({
      bills: [],
      billPaymentOverrides: [
        { billId: "ghost-bill", dueDate: "2026-06-01", amountCents: 100 },
      ],
    });
    await expect(importAll(user.id, payload)).rejects.toThrow(/unknown billId/);
  });

  it("rejects a card foreign key that points at another user's card", async () => {
    const a = await makeUser("a@example.com");
    const b = await makeUser("b@example.com");
    const otherCard = await createCreditCard(b.id, {
      name: "Bs Card",
      statementDay: 5,
      dueDay: 25,
      autoPay: false,
      isActive: true,
    });
    // Even though the target row exists *somewhere*, the import must reject
    // it because the cardId isn't inside the importer's own payload.
    const payload = envelope({
      creditCards: [],
      creditCardStatements: [
        {
          cardId: otherCard.id,
          statementDate: "2026-05-01",
          dueDate: "2026-05-25",
          statementBalanceCents: 100,
        },
      ],
    });
    await expect(importAll(a.id, payload)).rejects.toThrow(/unknown cardId/);
  });

  it("rejects duplicate card ids inside the payload", async () => {
    const user = await makeUser("a@example.com");
    const payload = envelope({
      creditCards: [
        { id: "dup", name: "A", statementDay: 5, dueDay: 25 },
        { id: "dup", name: "B", statementDay: 5, dueDay: 25 },
      ],
    });
    await expect(importAll(user.id, payload)).rejects.toThrow(/duplicate creditCard id/);
  });
});

describe("backup import / transactional rollback", () => {
  it("a failure mid-import leaves the user's existing rows intact", async () => {
    const user = await makeUser("a@example.com");
    const card = await createCreditCard(user.id, {
      name: "Existing",
      statementDay: 5,
      dueDay: 25,
      autoPay: false,
      isActive: true,
    });
    const bill = await createBill(user.id, {
      name: "Rent",
      category: "Housing",
      amountCents: 100_00,
      intervalMonths: 1,
      anchorDate: "2026-05-01",
      autoPay: false,
      paidViaCardId: null,
      notes: null,
      isActive: true,
    });

    // A bad statement reference would normally pass shape validation but
    // fail the graph check before any deletes run, so existing rows survive.
    const bad = envelope({
      creditCards: [],
      creditCardStatements: [
        {
          cardId: "ghost",
          statementDate: "2026-05-01",
          dueDate: "2026-05-25",
          statementBalanceCents: 100,
        },
      ],
    });
    await expect(importAll(user.id, bad)).rejects.toThrow();

    const db = getDb();
    const cards = await db.select().from(creditCards).where(eq(creditCards.userId, user.id)).all();
    const billRows = await db.select().from(bills).where(eq(bills.userId, user.id)).all();
    expect(cards.map((c) => c.id)).toContain(card.id);
    expect(billRows.map((b) => b.id)).toContain(bill.id);
  });

  it("a constraint violation during insert rolls back deletes", async () => {
    const user = await makeUser("a@example.com");
    const existingExtra = await getDb()
      .insert(oneTimeExpenses)
      .values({
        id: newId(),
        userId: user.id,
        date: "2026-05-01",
        description: "Concert",
        amountCents: 5000,
        category: "Entertainment",
      })
      .returning()
      .get();

    // Force a constraint failure inside the insert phase by giving two card
    // rows the same id. The Zod payload passes shape validation (ids unique
    // per row); the duplicate is detected by validateImportGraph before any
    // delete runs. We get the same surviving-data property that way.
    const payload = envelope({
      creditCards: [
        { id: "X", name: "A", statementDay: 5, dueDay: 25 },
        { id: "X", name: "B", statementDay: 5, dueDay: 25 },
      ],
    });
    await expect(importAll(user.id, payload)).rejects.toThrow();
    const db = getDb();
    const extras = await db.select().from(oneTimeExpenses).where(eq(oneTimeExpenses.userId, user.id)).all();
    expect(extras.map((e) => e.id)).toContain(existingExtra.id);
  });

  it("a successful round-trip preserves the user's data", async () => {
    const user = await makeUser("a@example.com");
    const card = await createCreditCard(user.id, {
      name: "Card A",
      statementDay: 5,
      dueDay: 25,
      autoPay: false,
      isActive: true,
    });
    await createBill(user.id, {
      name: "Rent",
      category: "Housing",
      amountCents: 100_00,
      intervalMonths: 1,
      anchorDate: "2026-05-01",
      autoPay: false,
      paidViaCardId: null,
      notes: null,
      isActive: true,
    });

    await upsertCreditCardPaymentOverride(user.id, card.id, { dueDate: "2026-05-01", amountCents: 20000, notes: null, trackPosting: true });
    await upsertCreditCardPaymentOverride(user.id, card.id, { dueDate: "2026-04-01", amountCents: 10000, notes: null, trackPosting: false });
    const exported = await exportAll(user.id);
    // Round-trip: parse with the schema, then import back over the user's
    // own data. End state should be equivalent.
    const parsed = backupImportSchema.parse(exported);
    await importAll(user.id, parsed);

    const restored = await exportAll(user.id);
    expect(restored.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(restored.creditCardPaymentOverrides.map((p) => [p.dueDate, p.trackPosting])).toEqual(
      exported.creditCardPaymentOverrides.map((p) => [p.dueDate, p.trackPosting]),
    );
    const db = getDb();
    const cards = await db.select().from(creditCards).where(eq(creditCards.userId, user.id)).all();
    const billRows = await db
      .select()
      .from(bills)
      .where(and(eq(bills.userId, user.id), eq(bills.isActive, true)))
      .all();
    expect(cards.map((c) => c.name)).toEqual(["Card A"]);
    expect(billRows.map((b) => b.name)).toEqual(["Rent"]);
  });
});

// R02 (review 2026-09-21): import replaces the user's data, so anything that
// isn't recognisably one of our backups must fail validation — never reach
// importAll's deletes.
describe("backup import / envelope is required before anything is replaced", () => {
  it("rejects an empty object", () => {
    expect(backupImportSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an unrelated JSON document", () => {
    expect(backupImportSchema.safeParse({ name: "package", version: "1.0.0" }).success).toBe(false);
    expect(backupImportSchema.safeParse([]).success).toBe(false);
  });

  it("rejects a backup from a newer app version", () => {
    const r = backupImportSchema.safeParse(envelope({ schemaVersion: BACKUP_SCHEMA_VERSION + 1 }));
    expect(r.success).toBe(false);
  });

  it("rejects a bill with no usable recurrence instead of silently skipping it", () => {
    const r = backupImportSchema.safeParse(
      envelope({ bills: [{ name: "Orphan", amountCents: 100 }] as never }),
    );
    expect(r.success).toBe(false);
  });

  it("still accepts legacy-recurrence bills and an old schema version", () => {
    const r = backupImportSchema.safeParse(
      envelope({
        schemaVersion: 2,
        bills: [{ name: "Old rent", amountCents: 100, frequency: "monthly", dueDay: 3 }],
      }),
    );
    expect(r.success).toBe(true);
  });

  it("preview reports what would be replaced without writing", async () => {
    const user = await makeUser("a@example.com");
    await createBill(user.id, {
      name: "Rent",
      category: "Housing",
      amountCents: 100_00,
      intervalMonths: 1,
      anchorDate: "2026-05-01",
      autoPay: false,
      paidViaCardId: null,
      notes: null,
      isActive: true,
    });
    const preview = await previewImport(user.id, envelope({ schemaVersion: 10 }));
    expect(preview.current.bills).toBe(1);
    expect(preview.incoming.bills).toBe(0);
    expect(preview.warnings.some((w) => w.includes("schema v10"))).toBe(true);
    const rows = await getDb().select().from(bills).where(eq(bills.userId, user.id)).all();
    expect(rows).toHaveLength(1);
  });
});

// R01 (review 2026-09-21): export → import must be lossless for every
// user-authored field, and the restored data must project identically.
describe("backup import / semantic round trip", () => {
  async function seedEverything(userId: string) {
    const db = getDb();
    db.insert(settings)
      .values({
        id: newId(),
        userId,
        startingBalanceCents: 123456,
        startingBalanceAsOf: "2026-09-01",
        defaultPaycheckCents: 250000,
        firstPaydayDate: "2026-09-25",
        payFrequencyDays: 14,
        projectionMonths: 3,
        currency: "USD",
        timezone: "America/Los_Angeles",
      })
      .run();
    db.insert(creditCards)
      .values({
        id: "card",
        userId,
        name: "Synthetic Card",
        statementDay: 5,
        dueDay: 25,
        gracePeriodDays: 25,
        creditLimitCents: 500000,
      })
      .run();
    db.insert(bills)
      .values({
        id: "bill",
        userId,
        name: "Synthetic utility",
        category: "Other",
        amountCents: 10000,
        intervalMonths: 1,
        anchorDate: "2026-09-01",
        matchAlias: "SYN UTILITY",
      })
      .run();
    db.insert(paychecks)
      .values({
        id: "pay",
        userId,
        payDate: "2026-09-25",
        amountCents: 100000,
        actualReceived: true,
        actualDate: "2026-09-23",
      })
      .run();
    db.insert(paychecks)
      .values({
        id: "bonus",
        userId,
        payDate: "2026-12-15",
        amountCents: 250000,
        note: "Year-end bonus",
        isOneTime: true,
      })
      .run();
    db.insert(creditCardStatements)
      .values({
        id: "stmt",
        cardId: "card",
        statementDate: "2026-09-05",
        dueDate: "2026-09-28",
        dueDateUserOverride: true,
        statementBalanceCents: 10000,
      })
      .run();
  }

  /** Export minus fields a restore legitimately regenerates. */
  function comparable(data: Awaited<ReturnType<typeof exportAll>>) {
    const strip = (rows: object[]) =>
      rows.map((r) => {
        const { createdAt: _c, updatedAt: _u, ...rest } = r as Record<string, unknown>;
        return rest;
      });
    const { exportedAt: _e, settings: s, ...collections } = data;
    const { updatedAt: _su, ...settingsRest } = s ?? ({} as NonNullable<typeof s>);
    return {
      settings: settingsRest,
      ...Object.fromEntries(
        Object.entries(collections).map(([k, v]) => [k, Array.isArray(v) ? strip(v as object[]) : v]),
      ),
    };
  }

  it("restores every exported field, including settings", async () => {
    const user = await makeUser("a@example.com");
    await seedEverything(user.id);
    const before = await exportAll(user.id);
    const projectionBefore = await buildProjection(user.id);

    // Drift everything the backup should put back.
    const db = getDb();
    db.update(settings).set({ startingBalanceCents: 99, projectionMonths: 12 }).run();
    db.update(creditCards).set({ gracePeriodDays: 14, creditLimitCents: null }).run();
    db.update(bills).set({ matchAlias: null }).run();
    db.update(paychecks).set({ actualDate: null, isOneTime: false }).run();
    db.update(creditCardStatements).set({ dueDateUserOverride: false }).run();

    await importAll(user.id, backupImportSchema.parse(JSON.parse(JSON.stringify(before))));

    const after = await exportAll(user.id);
    expect(comparable(after)).toEqual(comparable(before));
    expect(after.settings?.startingBalanceCents).toBe(123456);
    expect(after.creditCards[0]).toMatchObject({ gracePeriodDays: 25, creditLimitCents: 500000 });
    expect(after.bills[0]?.matchAlias).toBe("SYN UTILITY");
    expect(after.paychecks.find((p) => p.id === "pay")?.actualDate).toBe("2026-09-23");
    expect(after.paychecks.find((p) => p.id === "bonus")?.isOneTime).toBe(true);
    expect(after.creditCardStatements[0]?.dueDateUserOverride).toBe(true);

    const projectionAfter = await buildProjection(user.id);
    expect(projectionBefore?.rows.length).toBeGreaterThan(0);
    expect(projectionAfter?.rows).toEqual(projectionBefore?.rows);
    expect(projectionAfter?.startingBalanceCents).toBe(projectionBefore?.startingBalanceCents);
    expect(projectionAfter?.projectionMonths).toBe(projectionBefore?.projectionMonths);
  });

  // DATA-1 (audit 2026-11-10): export and import must share one value domain.
  // A statement PATCHed to a negative balance (a card carrying a credit) used
  // to export fine and then fail the import schema, so the user's backup and
  // the pre-import snapshot silently stopped restoring. Every row below is
  // first parsed by the WRITE schema that guards its real write path, so the
  // seed holds only values the app can actually store — at their bounds.
  async function seedBoundaries(userId: string) {
    const db = getDb();
    const ok = <T,>(schema: { parse: (v: unknown) => T }, input: unknown): T => schema.parse(input);
    const MAX = MAX_ABS_CENTS;
    const long = (n: number) => "x".repeat(n);

    db.insert(settings)
      .values({
        id: newId(),
        userId,
        ...ok(settingsUpdateSchema, {
          startingBalanceCents: -MAX,
          startingBalanceAsOf: "2026-09-01",
          defaultPaycheckCents: 0,
          firstPaydayDate: "2026-09-25",
          payFrequencyDays: 60,
          projectionMonths: 36,
          currency: "USD",
          timezone: "UTC",
        }),
      })
      .run();

    db.insert(creditCards)
      .values({
        id: "lo",
        userId,
        ...ok(creditCardCreateSchema, {
          name: "Card in credit",
          statementDay: 1,
          dueDay: 31,
          gracePeriodDays: 0,
          currentBalanceCents: 0,
          creditLimitCents: null,
          notes: null,
        }),
      })
      .run();
    db.insert(creditCards)
      .values({
        id: "hi",
        userId,
        ...ok(creditCardCreateSchema, {
          name: long(80),
          statementDay: 31,
          dueDay: 1,
          statementCycleMode: "interval_days",
          statementCycleAnchorDate: "2026-09-01",
          statementCycleIntervalDays: 366,
          gracePeriodDays: 60,
          currentBalanceCents: MAX,
          creditLimitCents: MAX,
          autoPay: true,
          notes: long(500),
        }),
      })
      .run();

    db.insert(bills)
      .values({
        id: "bill-lo",
        userId,
        ...ok(billCreateSchema, {
          name: "Free tier",
          category: "Other",
          amountCents: 0,
          intervalMonths: 1,
          anchorDate: "2026-09-01",
          matchAlias: null,
          notes: null,
        }),
      })
      .run();
    db.insert(bills)
      .values({
        id: "bill-hi",
        userId,
        ...ok(billCreateSchema, {
          name: long(80),
          category: long(50),
          amountCents: MAX,
          intervalMonths: 120,
          anchorDate: "2026-09-01",
          paidViaCardId: "hi",
          matchAlias: long(200),
          notes: long(500),
        }),
      })
      .run();
    db.insert(billPaymentOverrides)
      .values({
        id: "bpo",
        userId,
        billId: "bill-lo",
        ...ok(billPaymentOverrideSchema, { dueDate: "2026-10-01", amountCents: 0, notes: null }),
      })
      .run();
    db.insert(billPaymentStates)
      .values({
        id: "bps-0",
        userId,
        billId: "bill-lo",
        ...ok(billPaymentStateSchema, {
          dueDate: "2026-10-01",
          state: "sent",
          amountCents: 0,
          markedDate: "2026-09-30",
        }),
      })
      .run();
    db.insert(billPaymentStates)
      .values({
        id: "bps-null",
        userId,
        billId: "bill-hi",
        ...ok(billPaymentStateSchema, {
          dueDate: "2026-10-01",
          state: "paid_externally",
          amountCents: null,
          markedDate: "2026-09-30",
          notes: null,
        }),
      })
      .run();

    const { cardIds: vbCards, ...vb } = ok(variableBillCreateSchema, {
      name: "Card-paid groceries",
      category: "Food",
      amountCents: 0,
      intervalMonths: 120,
      anchorDate: "2026-09-01",
      cardIds: ["lo"],
      notes: null,
    });
    db.insert(variableBills).values({ id: "vb", userId, ...vb }).run();
    for (const cardId of vbCards) {
      db.insert(variableBillCards).values({ id: newId(), userId, variableBillId: "vb", cardId }).run();
    }

    db.insert(creditCardPaymentOverrides)
      .values({
        id: "cpo-0",
        userId,
        cardId: "lo",
        ...ok(creditCardPaymentOverrideSchema, { dueDate: "2026-10-31", amountCents: 0, notes: null }),
      })
      .run();
    const put = ok(cardPaymentOpSchema, { op: "put", cardId: "hi", dueDate: "2026-11-01", amountCents: MAX });
    if (put.op !== "put") throw new Error("unreachable");
    db.insert(creditCardPaymentOverrides)
      .values({ id: "cpo-max", userId, cardId: put.cardId, dueDate: put.dueDate, amountCents: put.amountCents })
      .run();

    db.insert(paychecks)
      .values({
        id: "clawback",
        userId,
        ...ok(paycheckCreateSchema, { payDate: "2026-10-15", amountCents: -MAX, note: long(120), isOneTime: true }),
      })
      .run();
    db.insert(paychecks)
      .values({
        id: "zero-pay",
        userId,
        ...ok(paycheckUpdateSchema, {
          payDate: "2026-10-01",
          amountCents: 0,
          note: null,
          actualReceived: true,
          actualAmountCents: -MAX,
        }),
      })
      .run();

    db.insert(oneTimeExpenses)
      .values({
        id: "refund",
        userId,
        ...ok(extraCreateSchema, {
          date: "2026-10-02",
          description: "Refund",
          amountCents: -MAX,
          category: "Other",
          paidViaCardId: "lo",
          notes: null,
        }),
      })
      .run();
    db.insert(oneTimeExpenses)
      .values({
        id: "big-extra",
        userId,
        ...ok(extraCreateSchema, {
          date: "2026-10-03",
          description: long(120),
          amountCents: MAX,
          category: long(50),
          notes: long(500),
        }),
      })
      .run();

    db.insert(categories)
      .values({
        id: "cat-neg",
        userId,
        ...ok(categoryCreateSchema, { name: long(50), color: "#4ade80", kind: "income", budgetAmountCents: -MAX }),
      })
      .run();
    db.insert(categories)
      .values({
        id: "cat-zero",
        userId,
        ...ok(categoryCreateSchema, { name: "Zero", color: "#000000", budgetAmountCents: 0 }),
      })
      .run();

    // The defect's case: created at $0 / minimum 0, then PATCHed to a credit
    // balance of -$25 (PATCH /api/credit-cards/statements/{id}). The Plaid
    // liabilities sync stores the same negative value unclamped.
    db.insert(creditCardStatements)
      .values({
        id: "credit",
        cardId: "lo",
        ...ok(statementCreateSchema, {
          statementDate: "2026-09-01",
          dueDate: "2026-09-30",
          statementBalanceCents: 0,
          minimumPaymentCents: 0,
          notes: null,
        }),
        ...ok(statementUpdateSchema, { statementBalanceCents: -2500 }),
      })
      .run();
    db.insert(creditCardStatements)
      .values({
        id: "max",
        cardId: "hi",
        ...ok(statementCreateSchema, {
          statementDate: "2026-09-30",
          dueDate: "2026-10-31",
          statementBalanceCents: MAX,
          minimumPaymentCents: MAX,
          notes: long(500),
        }),
        ...ok(statementUpdateSchema, { paidAmountCents: -MAX, paidDate: "2026-10-30" }),
      })
      .run();

    // Same default the promos POST route applies to an omitted remaining.
    const promoRow = (input: unknown) => {
      const p = ok(promoCreateSchema, input);
      return { ...p, remainingAmountCents: p.remainingAmountCents ?? p.originalAmountCents };
    };
    db.insert(creditCardPromos)
      .values({
        id: "promo-lo",
        userId,
        cardId: "lo",
        ...promoRow({
          description: "Paid off",
          originalAmountCents: 1,
          remainingAmountCents: 0,
          startDate: "2026-09-01",
          endDate: "2026-09-01",
          monthlyPaymentCents: null,
          notes: null,
          authoritativeSource: null,
        }),
      })
      .run();
    db.insert(creditCardPromos)
      .values({
        id: "promo-hi",
        userId,
        cardId: "hi",
        ...promoRow({
          description: long(120),
          originalAmountCents: MAX,
          remainingAmountCents: MAX,
          startDate: "2026-09-01",
          endDate: "2027-09-01",
          monthlyPaymentCents: MAX,
          notes: long(500),
          authoritativeSource: "manual_reconciliation",
        }),
      })
      .run();
    db.insert(creditCardPromoPayments)
      .values({
        id: "pp-1",
        userId,
        promoId: "promo-lo",
        ...ok(promoPaymentCreateSchema, { dueDate: "2026-09-30", amountCents: 1, note: null }),
      })
      .run();
    db.insert(creditCardPromoPayments)
      .values({
        id: "pp-max",
        userId,
        promoId: "promo-hi",
        ...ok(promoPaymentCreateSchema, { dueDate: "2026-10-31", amountCents: MAX, note: long(500) }),
      })
      .run();

    db.insert(assets)
      .values({
        id: "liability",
        userId,
        ...ok(assetCreateSchema, { name: "Underwater", valueCents: -MAX, category: "vehicle", asOfDate: "2026-09-01" }),
      })
      .run();
    db.insert(assets)
      .values({
        id: "house",
        userId,
        ...ok(assetCreateSchema, {
          name: long(80),
          valueCents: MAX,
          category: "real_estate",
          notes: long(500),
          asOfDate: "2026-09-01",
        }),
      })
      .run();
  }

  it("restores every boundary value a write path accepts (one value domain)", async () => {
    const user = await makeUser("a@example.com");
    await seedBoundaries(user.id);
    const before = await exportAll(user.id);

    const parsed = backupImportSchema.safeParse(JSON.parse(JSON.stringify(before)));
    // List every rejected field, so a future gap names itself.
    expect(
      parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    ).toEqual([]);

    // Drift the defect's row so the restore has to put it back.
    getDb()
      .update(creditCardStatements)
      .set({ statementBalanceCents: 0 })
      .where(eq(creditCardStatements.id, "credit"))
      .run();
    await importAll(user.id, parsed.data!);

    const after = await exportAll(user.id);
    expect(comparable(after)).toEqual(comparable(before));
    expect(after.creditCardStatements.find((s) => s.id === "credit")?.statementBalanceCents).toBe(-2500);
    expect(after.creditCards.find((c) => c.id === "lo")?.creditLimitCents).toBeNull();
  });
});

describe("backup import / pre-import snapshot", () => {
  it("writes the current data and keeps only the newest five per user", async () => {
    const user = await makeUser("a@example.com");
    const names: string[] = [];
    for (let i = 0; i < 7; i++) {
      names.push(await writePreImportSnapshot(user.id, new Date(Date.UTC(2026, 8, 21, 0, 0, i))));
    }
    const kept = fs.readdirSync(snapshotDir()).filter((f) => f.startsWith(user.id)).sort();
    expect(kept).toEqual(names.slice(2));
    const saved = JSON.parse(fs.readFileSync(path.join(snapshotDir(), kept[0]!), "utf8"));
    expect(backupImportSchema.safeParse(saved).success).toBe(true);
  });
});

// Review 2026-09-24 C02: a restore on the same install used to write
// plaidAccountId = null on every card, cutting linked cards off from
// statements, payment matching and classification — including when the user
// re-imported the pre-import snapshot to undo a restore.
describe("backup import / Plaid card links", () => {
  async function linkedCard(userId: string, opts: { accountId: string; itemActive?: boolean; name?: string }) {
    const item = await createPlaidItem(userId, {
      institutionId: "ins", institutionName: "Bank",
      accessTokenEnc: "00", accessTokenIv: "00", accessTokenTag: "00",
      cursor: null, lastSyncedAt: null, isActive: opts.itemActive ?? true,
    });
    await upsertPlaidAccount({
      id: opts.accountId, itemId: item.id, userId, name: "Card account",
      mask: "1111", type: "credit", subtype: "credit card",
      balanceCents: 0, updatedAt: Date.now(),
    });
    return createCreditCard(userId, {
      name: opts.name ?? "Visa", statementDay: 1, dueDay: 21, autoPay: false, isActive: true,
      plaidAccountId: opts.accountId,
    });
  }

  const roundTrip = async (userId: string) =>
    backupImportSchema.parse(JSON.parse(JSON.stringify(await exportAll(userId))));

  it("export → import on the same install keeps a card's link", async () => {
    const user = await makeUser("links@x.com");
    const card = await linkedCard(user.id, { accountId: "acct_visa" });
    const payload = await roundTrip(user.id);

    const preview = await previewImport(user.id, payload);
    expect(preview.warnings.join(" ")).not.toMatch(/bank link/);

    await importAll(user.id, payload);
    expect((await getCreditCard(user.id, card.id))?.plaidAccountId).toBe("acct_visa");
  });

  it("restoring the pre-import snapshot keeps links", async () => {
    const user = await makeUser("undo@x.com");
    const card = await linkedCard(user.id, { accountId: "acct_undo" });
    const name = await writePreImportSnapshot(user.id);
    const snapshot = backupImportSchema.parse(
      JSON.parse(fs.readFileSync(path.join(snapshotDir(), name), "utf8")),
    );
    await importAll(user.id, snapshot);
    expect((await getCreditCard(user.id, card.id))?.plaidAccountId).toBe("acct_undo");
  });

  it("drops, with a warning, a link to an account that is not this user's", async () => {
    const owner = await makeUser("owner@x.com");
    const other = await makeUser("other@x.com");
    await linkedCard(owner.id, { accountId: "acct_owner" });
    const payload = envelope({
      creditCards: [{ id: "card_x", name: "Borrowed", statementDay: 1, dueDay: 21, plaidAccountId: "acct_owner" }],
    });

    const preview = await previewImport(other.id, payload);
    expect(preview.warnings).toContain(
      'Card "Borrowed" restores without its bank link: that account is not connected here.',
    );
    await importAll(other.id, payload);
    expect((await getCreditCard(other.id, "card_x"))?.plaidAccountId).toBeNull();
  });

  it("drops a link to a removed bank", async () => {
    const user = await makeUser("removed@x.com");
    const card = await linkedCard(user.id, { accountId: "acct_gone", itemActive: false });
    const payload = await roundTrip(user.id);
    expect((await previewImport(user.id, payload)).warnings.join(" ")).toMatch(/Visa.*not connected here/);
    await importAll(user.id, payload);
    expect((await getCreditCard(user.id, card.id))?.plaidAccountId).toBeNull();
  });

  it("drops both links, never crashing, when two cards claim one account", async () => {
    const user = await makeUser("dupe@x.com");
    await linkedCard(user.id, { accountId: "acct_shared" });
    const payload = envelope({
      creditCards: [
        { id: "card_a", name: "A", statementDay: 1, dueDay: 21, plaidAccountId: "acct_shared" },
        { id: "card_b", name: "B", statementDay: 1, dueDay: 21, plaidAccountId: "acct_shared" },
      ],
    });
    const preview = await previewImport(user.id, payload);
    expect(preview.warnings.filter((w) => w.includes("another card in the backup"))).toHaveLength(2);
    await importAll(user.id, payload);
    expect((await getCreditCard(user.id, "card_a"))?.plaidAccountId).toBeNull();
    expect((await getCreditCard(user.id, "card_b"))?.plaidAccountId).toBeNull();
  });
});
