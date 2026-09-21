import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("./auth", () => ({ hashPassword: async (p: string) => `mock-hash-${p}` }));

import { matchAllocatedObligations, splitIsValid } from "./bill-reconciliation";
import { reconcilePlannedCardPayments } from "./card-payment-reconciliation";
import { __resetDbCacheForTests, getDb, runMigrations } from "./db/client";
import { draftAllocations, paychecks, users } from "./db/schema";
import {
  createPlaidItem,
  findInvalidSplitDraftIds,
  reopenPaycheckSettledByDraft,
  upsertPlaidAccount,
  upsertPlaidDraft,
} from "./repos";

// Review 2026-09-21 R07: a split is checked against the transaction when it
// is saved, but the bank can later correct the transaction. A stale $1,000
// split on a corrected $100 debit settled $1,000 of obligations.

describe("splitIsValid", () => {
  it.each([
    [{ amountCents: 100, allocations: [] }, true],
    [{ amountCents: 100 }, true],
    [{ amountCents: -100, allocations: undefined }, true],
    [{ amountCents: 100, allocations: [{ amountCents: 60 }, { amountCents: 40 }] }, true],
    [{ amountCents: 100, allocations: [{ amountCents: 60 }, { amountCents: 41 }] }, false],
    [{ amountCents: 0, allocations: [{ amountCents: 1 }] }, false],
    [{ amountCents: -100, allocations: [{ amountCents: 50 }] }, false],
    [{ amountCents: 100, allocations: [{ amountCents: 0 }] }, false],
  ])("%j → %s", (draft, valid) => {
    expect(splitIsValid(draft)).toBe(valid);
  });
});

describe("reconciliation ignores a split the bank has invalidated", () => {
  const stale = {
    id: "d",
    date: "2026-09-21",
    description: "Synthetic Card payment",
    merchantName: null,
    amountCents: 10_000,
  };

  it("card payments: the corrected $100 debit credits nothing and isn't heuristically matched", () => {
    const posted = reconcilePlannedCardPayments(
      [{ cardId: "c", cardName: "Synthetic Card", date: "2026-09-21", amountCents: 10_000 }],
      [{ ...stale, allocations: [{ targetKind: "card_payment", targetId: "c", targetDate: "2026-09-21", amountCents: 100_000 }] }],
    );
    expect(posted.get("c:2026-09-21") ?? 0).toBe(0);
  });

  it("card payments: a valid split still credits", () => {
    const posted = reconcilePlannedCardPayments(
      [{ cardId: "c", cardName: "Synthetic Card", date: "2026-09-21", amountCents: 10_000 }],
      [{ ...stale, allocations: [{ targetKind: "card_payment", targetId: "c", targetDate: "2026-09-21", amountCents: 10_000 }] }],
    );
    expect(posted.get("c:2026-09-21")).toBe(10_000);
  });

  it("bills: nothing is marked paid, and the draft stays out of heuristic matching", () => {
    const matched = matchAllocatedObligations(
      [{ id: "b", name: "Synthetic bill", amountCents: 100_000, anchorDate: "2026-09-21", intervalMonths: 1 }],
      [],
      [{ ...stale, allocations: [{ targetKind: "bill", targetId: "b", targetDate: "2026-09-21", amountCents: 100_000 }] }],
    );
    expect(matched.bills).toEqual([]);
    expect(matched.allocatedDraftIds.has("d")).toBe(true);
  });
});

describe("repo support", () => {
  let dir: string;
  beforeEach(async () => {
    __resetDbCacheForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-split-"));
    process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
    runMigrations();
    getDb().insert(users).values({ id: "u", email: "u@example.com", passwordHash: "x", displayName: "U" }).run();
    const item = await createPlaidItem("u", {
      institutionId: "ins", institutionName: "Bank", accessTokenEnc: "00", accessTokenIv: "00",
      accessTokenTag: "00", cursor: null, lastSyncedAt: null, isActive: true,
    });
    await upsertPlaidAccount({
      id: "checking", itemId: item.id, userId: "u", name: "Checking", mask: "0001",
      type: "depository", subtype: "checking", balanceCents: 0, updatedAt: Date.now(),
    });
    for (const [id, amountCents] of [["ok", 10_000], ["stale", 10_000], ["flipped", -5_000]] as const) {
      await upsertPlaidDraft({
        id, userId: "u", accountId: "checking", date: "2026-09-20", description: id,
        originalDescription: id, amountCents, plaidCategory: null, merchantName: null, pending: false,
      });
    }
    const alloc = (draftId: string, amountCents: number, targetId = "b") =>
      getDb().insert(draftAllocations).values({
        id: `${draftId}-${targetId}`, userId: "u", draftId, targetKind: "bill", targetId,
        targetDate: "2026-09-20", amountCents,
      }).run();
    alloc("ok", 6_000);
    alloc("ok", 4_000, "b2");
    alloc("stale", 100_000);
    alloc("flipped", 5_000);
  });
  afterEach(() => {
    __resetDbCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds splits that no longer fit their transaction", async () => {
    expect([...(await findInvalidSplitDraftIds("u"))].sort()).toEqual(["flipped", "stale"]);
    expect([...(await findInvalidSplitDraftIds("u", ["ok", "stale"]))]).toEqual(["stale"]);
    expect((await findInvalidSplitDraftIds("u", [])).size).toBe(0);
  });

  it("reopens only the paycheck a removed deposit settled", async () => {
    getDb().insert(paychecks).values([
      { id: "p1", userId: "u", payDate: "2026-09-19", amountCents: 1, actualReceived: true,
        actualAmountCents: 1, actualDate: "2026-09-18", settledByDraftId: "deposit-1" },
      { id: "p2", userId: "u", payDate: "2026-09-05", amountCents: 1, actualReceived: true },
    ]).run();
    expect((await reopenPaycheckSettledByDraft("u", "deposit-1"))?.id).toBe("p1");
    const rows = getDb().select().from(paychecks).all();
    expect(rows.find((r) => r.id === "p1")).toMatchObject({
      actualReceived: false, actualAmountCents: null, actualDate: null, settledByDraftId: null,
    });
    expect(rows.find((r) => r.id === "p2")?.actualReceived).toBe(true);
    expect(await reopenPaycheckSettledByDraft("u", "deposit-1")).toBeUndefined();
  });
});
