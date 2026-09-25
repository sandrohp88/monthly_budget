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
  createBill,
  createCreditCard,
  createPlaidItem,
  deleteCreditCardPaymentOverride,
  findOrphanedAllocationDraftIds,
  listCreditCardPaymentOverridesForUser,
  listDraftAllocations,
  replaceDraftAllocations,
  updateBill,
  upsertCreditCardPaymentOverride,
  upsertPlaidAccount,
  upsertPlaidDraft,
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

// Review 2026-09-24 C05: links from a bank transaction to a planned payment
// are keyed by (card, date). Moving the plan used to strand the link: the
// moved plan held its full amount as "awaiting post" while the draft, having
// a split, stayed out of automatic matching.
describe("applyCardPaymentOps / bank-transaction links", () => {
  async function linkDebit(id: string, amountCents: number, targets: Array<{ date: string; cents: number }>) {
    await upsertPlaidDraft({
      id, userId: "u", accountId: "checking", date: "2026-10-18",
      description: "CARD PAYMENT", amountCents,
      plaidCategory: "LOAN_PAYMENTS", merchantName: null, pending: false,
      status: "approved", linkedExpenseId: null,
    });
    await replaceDraftAllocations("u", id, targets.map((t) => ({
      targetKind: "card_payment" as const, targetId: cardId, targetDate: t.date, amountCents: t.cents,
    })));
  }
  const linkDates = async (draftId: string) =>
    (await listDraftAllocations("u", draftId)).map((a) => [a.targetDate, a.amountCents]);

  beforeEach(async () => {
    const item = await createPlaidItem("u", {
      institutionId: "ins", institutionName: "Bank",
      accessTokenEnc: "00", accessTokenIv: "00", accessTokenTag: "00",
      cursor: null, lastSyncedAt: null, isActive: true,
    });
    await upsertPlaidAccount({
      id: "checking", itemId: item.id, userId: "u", name: "Checking", mask: null,
      type: "depository", subtype: "checking", balanceCents: 0, updatedAt: Date.now(),
    });
  });

  it("a move carries the link to the new date", async () => {
    await linkDebit("txn_pay", 50_000, [{ date: "2026-10-25", cents: 50_000 }]);
    applyCardPaymentOps("u", [
      { op: "delete", cardId, dueDate: "2026-10-25", mustExist: true },
      { op: "put", cardId, dueDate: "2026-10-20", amountCents: 50_000, notes: null },
    ]);
    expect(await linkDates("txn_pay")).toEqual([["2026-10-20", 50_000]]);
    expect(await findOrphanedAllocationDraftIds("u")).toEqual(new Set());
  });

  it("the calendar's pay-early pattern (vacate marker + moved row) carries the link", async () => {
    await linkDebit("txn_pay", 50_000, [{ date: "2026-10-25", cents: 50_000 }]);
    applyCardPaymentOps("u", [
      { op: "put", cardId, dueDate: "2026-10-25", amountCents: 0, notes: "moved-to:2026-10-18", replace: true },
      { op: "put", cardId, dueDate: "2026-10-18", amountCents: 50_000, notes: "moved-from:2026-10-25" },
    ]);
    expect(await linkDates("txn_pay")).toEqual([["2026-10-18", 50_000]]);
  });

  it("merges with a link the same transaction already has on the new date", async () => {
    await linkDebit("txn_split", 57_000, [
      { date: "2026-10-25", cents: 50_000 },
      { date: "2026-10-10", cents: 7_000 },
    ]);
    applyCardPaymentOps("u", [
      { op: "delete", cardId, dueDate: "2026-10-25", mustExist: true },
      { op: "put", cardId, dueDate: "2026-10-10", amountCents: 57_000, notes: null, replace: true },
    ]);
    expect(await linkDates("txn_split")).toEqual([["2026-10-10", 57_000]]);
  });

  it("refuses to delete a linked payment unless the caller confirms", async () => {
    await linkDebit("txn_pay", 50_000, [{ date: "2026-10-25", cents: 50_000 }]);
    const before = await rows();
    let error: unknown;
    try {
      applyCardPaymentOps("u", [{ op: "delete", cardId, dueDate: "2026-10-25" }]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CardPaymentConflictError);
    expect((error as CardPaymentConflictError).code).toBe("linked_payment");
    expect(await rows()).toEqual(before);
    expect(await linkDates("txn_pay")).toEqual([["2026-10-25", 50_000]]);

    applyCardPaymentOps("u", [{ op: "delete", cardId, dueDate: "2026-10-25" }], { unlinkAllocations: true });
    expect((await rows()).map((r) => r[0])).toEqual(["2026-10-10"]);
    expect(await linkDates("txn_pay")).toEqual([]);
  });

  it("refuses when a change leaves two possible new dates", async () => {
    await linkDebit("txn_pay", 50_000, [{ date: "2026-10-25", cents: 50_000 }]);
    expect(() =>
      applyCardPaymentOps("u", [
        { op: "delete", cardId, dueDate: "2026-10-25", mustExist: true },
        { op: "put", cardId, dueDate: "2026-10-20", amountCents: 25_000, notes: null },
        { op: "put", cardId, dueDate: "2026-10-22", amountCents: 25_000, notes: null },
      ]),
    ).toThrow(CardPaymentConflictError);
    expect(await linkDates("txn_pay")).toEqual([["2026-10-25", 50_000]]);
  });

  it("an amount edit on the same date leaves the link alone", async () => {
    await linkDebit("txn_pay", 50_000, [{ date: "2026-10-25", cents: 50_000 }]);
    applyCardPaymentOps("u", [
      { op: "put", cardId, dueDate: "2026-10-25", amountCents: 49_500, notes: null, replace: true },
    ]);
    expect(await linkDates("txn_pay")).toEqual([["2026-10-25", 50_000]]);
  });

  it("flags links left pointing at a removed plan or a bill date that moved", async () => {
    await linkDebit("txn_pay", 50_000, [{ date: "2026-10-25", cents: 50_000 }]);
    // A legacy path that bypasses the batch guard strands the link.
    await deleteCreditCardPaymentOverride("u", cardId, "2026-10-25");

    const bill = await createBill("u", {
      name: "Rent", category: "Housing", amountCents: 150_000, intervalMonths: 1,
      anchorDate: "2026-10-01", autoPay: false, isActive: true,
    });
    await upsertPlaidDraft({
      id: "txn_rent", userId: "u", accountId: "checking", date: "2026-10-01",
      description: "RENT", amountCents: 150_000, plaidCategory: null, merchantName: null,
      pending: false, status: "approved", linkedExpenseId: null,
    });
    await replaceDraftAllocations("u", "txn_rent", [
      { targetKind: "bill", targetId: bill.id, targetDate: "2026-10-01", amountCents: 150_000 },
    ]);
    expect(await findOrphanedAllocationDraftIds("u")).toEqual(new Set(["txn_pay"]));

    await updateBill("u", bill.id, { anchorDate: "2026-10-03" });
    expect(await findOrphanedAllocationDraftIds("u")).toEqual(new Set(["txn_pay", "txn_rent"]));
  });
});
