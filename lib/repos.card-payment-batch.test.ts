import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("./auth", () => ({ hashPassword: async (p: string) => `mock-hash-${p}` }));

import { __resetDbCacheForTests, getDb, runMigrations } from "./db/client";
import { users } from "./db/schema";
import {
  applyCardPaymentOps,
  CardPaymentConflictError,
  createCreditCard,
  listCreditCardPaymentOverridesForUser,
  upsertCreditCardPaymentOverride,
} from "./repos";

// Review 2026-09-21 R06: a calendar move was DELETE then PUT in separate
// requests. A failure between them lost the payment; a PUT onto an occupied
// date silently overwrote another plan.

let dir: string;
let cardId: string;
beforeEach(async () => {
  __resetDbCacheForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-batch-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  runMigrations();
  for (const id of ["u", "other"]) {
    getDb().insert(users).values({ id, email: `${id}@example.com`, passwordHash: "x", displayName: id }).run();
  }
  cardId = (await createCreditCard("u", { name: "Card", statementDay: 5, dueDay: 25, autoPay: false, isActive: true })).id;
  await upsertCreditCardPaymentOverride("u", cardId, { dueDate: "2026-10-25", amountCents: 50_000, notes: null });
  await upsertCreditCardPaymentOverride("u", cardId, { dueDate: "2026-10-10", amountCents: 7_000, notes: "other plan" });
});
afterEach(() => {
  __resetDbCacheForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function rows() {
  return (await listCreditCardPaymentOverridesForUser("u"))
    .map((o) => [o.dueDate, o.amountCents, o.notes])
    .sort();
}

describe("applyCardPaymentOps", () => {
  it("moves a payment atomically", async () => {
    applyCardPaymentOps("u", [
      { op: "delete", cardId, dueDate: "2026-10-25", mustExist: true },
      { op: "put", cardId, dueDate: "2026-10-20", amountCents: 50_000, notes: null },
    ]);
    expect(await rows()).toEqual([
      ["2026-10-10", 7_000, "other plan"],
      ["2026-10-20", 50_000, null],
    ]);
  });

  it("rolls back the delete when a later op fails", async () => {
    const before = await rows();
    expect(() =>
      applyCardPaymentOps("u", [
        { op: "delete", cardId, dueDate: "2026-10-25", mustExist: true },
        { op: "put", cardId, dueDate: "2026-10-10", amountCents: 50_000, notes: null },
      ]),
    ).toThrow(CardPaymentConflictError);
    expect(await rows()).toEqual(before);
  });

  it("never silently overwrites another plan; replace is explicit", async () => {
    expect(() =>
      applyCardPaymentOps("u", [{ op: "put", cardId, dueDate: "2026-10-10", amountCents: 1, notes: null }]),
    ).toThrow(/already planned/);
    applyCardPaymentOps("u", [
      { op: "put", cardId, dueDate: "2026-10-10", amountCents: 8_000, notes: "edited", replace: true },
    ]);
    expect((await rows()).find((r) => r[0] === "2026-10-10")).toEqual(["2026-10-10", 8_000, "edited"]);
  });

  it("rejects a move whose source was already removed (stale view)", async () => {
    applyCardPaymentOps("u", [{ op: "delete", cardId, dueDate: "2026-10-25" }]);
    const before = await rows();
    expect(() =>
      applyCardPaymentOps("u", [
        { op: "delete", cardId, dueDate: "2026-10-25", mustExist: true },
        { op: "put", cardId, dueDate: "2026-10-20", amountCents: 50_000, notes: null },
      ]),
    ).toThrow(/changed since you opened it/);
    expect(await rows()).toEqual(before);
  });

  it("rejects another user's card without writing anything", async () => {
    const before = await rows();
    expect(() =>
      applyCardPaymentOps("other", [{ op: "delete", cardId, dueDate: "2026-10-25" }]),
    ).toThrow("card not found");
    expect(await rows()).toEqual(before);
  });

  it("treats a delete of a missing row as a no-op unless mustExist", async () => {
    expect(() => applyCardPaymentOps("u", [{ op: "delete", cardId, dueDate: "2026-12-25" }])).not.toThrow();
  });
});
