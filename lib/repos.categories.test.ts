import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// repos.ts imports ./auth → next-auth → next/server; stub it (see repos.test.ts).
vi.mock("./auth", () => ({
  hashPassword: async (p: string) => `mock-hash-${p}`,
}));

import { __resetDbCacheForTests, getDb, runMigrations } from "./db/client";
import { users } from "./db/schema";
import { newId } from "./ids";
import {
  categoryUsageCount,
  computeCategoryUtilization,
  createBill,
  createCategory,
  createCreditCard,
  createExtra,
  createVariableBill,
  listBills,
  updateCategory,
} from "./repos";

let dbDir: string;
beforeEach(() => {
  __resetDbCacheForTests();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-categories-"));
  process.env.DATABASE_URL = `file:${path.join(dbDir, "test.db")}`;
  getDb();
  runMigrations();
});
afterEach(() => {
  __resetDbCacheForTests();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

async function makeUser(email = "test@example.com"): Promise<{ id: string }> {
  const id = newId();
  await getDb()
    .insert(users)
    .values({ id, email, passwordHash: "x".repeat(64), displayName: "Tester", role: "admin" })
    .run();
  return { id };
}

// ────────────────────────────────────────────────────────────────────────────
// Categories are referenced by NAME (review 2026-09-24 C06): a rename must
// carry bills, variable bills and one-time expenses with it.
// ────────────────────────────────────────────────────────────────────────────
describe("repos / category rename", () => {
  async function seed() {
    const user = await makeUser();
    const cat = await createCategory(user.id, { name: "Groceries", color: "#4ade80", kind: "expense", budgetAmountCents: 500_00 });
    await createBill(user.id, {
      name: "Farm box", category: "Groceries", amountCents: 60_00, intervalMonths: 1,
      anchorDate: "2026-09-05", autoPay: false, isActive: true,
    });
    await createExtra(user.id, { date: "2026-09-12", description: "Market", amountCents: 40_00, category: "Groceries", notes: null });
    const card = await createCreditCard(user.id, { name: "Visa", statementDay: 1, dueDay: 21, autoPay: false, isActive: true });
    await createVariableBill(user.id, {
      name: "Costco", category: "Groceries", amountCents: 150_00, intervalMonths: 1,
      anchorDate: "2026-09-20", notes: null, isActive: true, cardIds: [card.id],
    });
    return { userId: user.id, catId: cat.id };
  }

  it("keeps the category's spending after a rename", async () => {
    const { userId, catId } = await seed();
    const before = (await computeCategoryUtilization(userId, "2026-09")).find((c) => c.category === "Groceries");
    expect(before?.spentCents).toBeGreaterThan(0);

    await updateCategory(userId, catId, { name: "Food" });

    const after = await computeCategoryUtilization(userId, "2026-09");
    expect(after.find((c) => c.category === "Food")?.spentCents).toBe(before?.spentCents);
    expect((await listBills(userId)).map((b) => b.category)).toEqual(["Food"]);
    expect(await categoryUsageCount(userId, "Food")).toBe(3);
    expect(await categoryUsageCount(userId, "Groceries")).toBe(0);
  });

  it("counts variable bills as uses, so an in-use category can't be deleted", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, { name: "Visa", statementDay: 1, dueDay: 21, autoPay: false, isActive: true });
    await createVariableBill(user.id, {
      name: "Electric", category: "Utilities", amountCents: 90_00, intervalMonths: 1,
      anchorDate: "2026-09-15", notes: null, isActive: true, cardIds: [card.id],
    });
    expect(await categoryUsageCount(user.id, "Utilities")).toBe(1);
  });

  it("leaves other users' rows with the same category name alone", async () => {
    const { userId, catId } = await seed();
    const other = await makeUser("other@example.com");
    await createBill(other.id, {
      name: "Other farm box", category: "Groceries", amountCents: 60_00, intervalMonths: 1,
      anchorDate: "2026-09-05", autoPay: false, isActive: true,
    });
    await updateCategory(userId, catId, { name: "Food" });
    expect((await listBills(other.id)).map((b) => b.category)).toEqual(["Groceries"]);
  });

  it("a color-only edit touches nothing else", async () => {
    const { userId, catId } = await seed();
    await updateCategory(userId, catId, { color: "#000000" });
    expect(await categoryUsageCount(userId, "Groceries")).toBe(3);
  });
});
