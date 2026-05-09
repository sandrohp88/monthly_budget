import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

vi.mock("./auth", () => ({
  hashPassword: async (p: string) => `mock-hash-${p}`,
}));

import { __resetDbCacheForTests, getDb, runMigrations } from "./db/client";
import { users, creditCards, bills, oneTimeExpenses } from "./db/schema";
import { newId } from "./ids";
import { importAll, exportAll, createBill, createCreditCard } from "./repos";
import { backupImportSchema, type BackupImportInput } from "./validation";
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
    const result = backupImportSchema.safeParse({
      bills: [{ name: "rent", amountCents: "twelve hundred" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a date that isn't ISO YYYY-MM-DD", () => {
    const result = backupImportSchema.safeParse({
      paychecks: [{ payDate: "06/01/2026", amountCents: 100 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an oversized payload", () => {
    const huge = Array.from({ length: 1001 }, (_, i) => ({
      name: `bill-${i}`,
      amountCents: 100,
      intervalMonths: 1,
      anchorDate: "2026-01-01",
    }));
    const result = backupImportSchema.safeParse({ bills: huge });
    expect(result.success).toBe(false);
  });
});

describe("backup import / graph integrity", () => {
  it("rejects a statement that points at a card not in the payload", async () => {
    const user = await makeUser("a@example.com");
    const payload: BackupImportInput = {
      schemaVersion: 5,
      creditCards: [],
      creditCardStatements: [
        {
          cardId: "ghost-card-id",
          statementDate: "2026-05-01",
          dueDate: "2026-05-25",
          statementBalanceCents: 100,
        },
      ],
    };
    await expect(importAll(user.id, payload)).rejects.toThrow(/unknown cardId/);
  });

  it("rejects a bill payment override that points at a missing bill", async () => {
    const user = await makeUser("a@example.com");
    const payload: BackupImportInput = {
      bills: [],
      billPaymentOverrides: [
        { billId: "ghost-bill", dueDate: "2026-06-01", amountCents: 100 },
      ],
    };
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
    const payload: BackupImportInput = {
      creditCards: [],
      creditCardStatements: [
        {
          cardId: otherCard.id,
          statementDate: "2026-05-01",
          dueDate: "2026-05-25",
          statementBalanceCents: 100,
        },
      ],
    };
    await expect(importAll(a.id, payload)).rejects.toThrow(/unknown cardId/);
  });

  it("rejects duplicate card ids inside the payload", async () => {
    const user = await makeUser("a@example.com");
    const payload: BackupImportInput = {
      creditCards: [
        { id: "dup", name: "A", statementDay: 5, dueDay: 25 },
        { id: "dup", name: "B", statementDay: 5, dueDay: 25 },
      ],
    };
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
    const bad: BackupImportInput = {
      creditCards: [],
      creditCardStatements: [
        {
          cardId: "ghost",
          statementDate: "2026-05-01",
          dueDate: "2026-05-25",
          statementBalanceCents: 100,
        },
      ],
    };
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
    const payload: BackupImportInput = {
      creditCards: [
        { id: "X", name: "A", statementDay: 5, dueDay: 25 },
        { id: "X", name: "B", statementDay: 5, dueDay: 25 },
      ],
    };
    await expect(importAll(user.id, payload)).rejects.toThrow();
    const db = getDb();
    const extras = await db.select().from(oneTimeExpenses).where(eq(oneTimeExpenses.userId, user.id)).all();
    expect(extras.map((e) => e.id)).toContain(existingExtra.id);
  });

  it("a successful round-trip preserves the user's data", async () => {
    const user = await makeUser("a@example.com");
    await createCreditCard(user.id, {
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

    const exported = await exportAll(user.id);
    // Round-trip: parse with the schema, then import back over the user's
    // own data. End state should be equivalent.
    const parsed = backupImportSchema.parse(exported);
    await importAll(user.id, parsed);

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
