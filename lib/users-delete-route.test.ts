/**
 * DELETE /api/users/[id] revokes the removed user's active Plaid Items at
 * Plaid before the row (and its encrypted tokens) is deleted (review
 * 2026-11-10 AUTH-4). Mocked Plaid client, real SQLite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

vi.mock("./auth", () => ({
  hashPassword: async (p: string) => `mock-hash-${p}`,
  requireAdmin: async () => "admin-id",
  requireUserId: async () => "admin-id",
  getCurrentUserRole: async () => "admin",
}));
vi.mock("server-only", () => ({}));

const __plaidMock = { itemRemove: vi.fn() };
let plaidConfigured = true;
vi.mock("./plaid-client", () => ({
  getPlaidClient: () => {
    if (!plaidConfigured) throw new Error("PLAID_CLIENT_ID and PLAID_SECRET must be set");
    return __plaidMock;
  },
}));

import { __resetDbCacheForTests, getDb, runMigrations } from "./db/client";
import { users } from "./db/schema";
import { newId } from "./ids";
import { createPlaidItem, getUserById, deactivatePlaidItem } from "./repos";
import { encryptToken } from "./plaid-crypto";
import { DELETE } from "@/app/api/users/[id]/route";

let dbDir: string;

beforeEach(() => {
  __resetDbCacheForTests();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-userdel-"));
  process.env.DATABASE_URL = `file:${path.join(dbDir, "test.db")}`;
  process.env.PLAID_ENCRYPTION_KEY = "a".repeat(64);
  getDb();
  runMigrations();
  plaidConfigured = true;
  __plaidMock.itemRemove.mockReset();
  __plaidMock.itemRemove.mockResolvedValue({ data: {} });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetDbCacheForTests();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

async function mkUser(email: string, role: "admin" | "member"): Promise<string> {
  const id = newId();
  await getDb()
    .insert(users)
    .values({ id, email, passwordHash: "x".repeat(64), displayName: email, role })
    .run();
  return id;
}

async function mkItem(userId: string, token: string, isActive = true) {
  const t = encryptToken(token);
  return createPlaidItem(userId, {
    institutionId: "ins_test",
    institutionName: "Test Bank",
    accessTokenEnc: t.enc,
    accessTokenIv: t.iv,
    accessTokenTag: t.tag,
    cursor: null,
    lastSyncedAt: null,
    isActive,
  });
}

function call(id: string) {
  return DELETE(new Request("http://x/api/users/" + id, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });
}

describe("DELETE /api/users/[id] revokes Plaid items", () => {
  beforeEach(async () => {
    await mkUser("admin@x.test", "admin"); // keeps an admin so the member delete is legal
  });

  it("revokes each active item with its own token, then deletes the user", async () => {
    const m = await mkUser("m@x.test", "member");
    await mkItem(m, "access-token-one");
    await mkItem(m, "access-token-two");
    __plaidMock.itemRemove.mockImplementation(async () => {
      // revoke happens BEFORE the delete: the user must still exist here
      expect(await getUserById(m)).toBeDefined();
      return { data: {} };
    });
    const res = await call(m);
    expect(res.status).toBe(200);
    const calls = __plaidMock.itemRemove.mock.calls.map((c) => c[0].access_token).sort();
    expect(calls).toEqual(["access-token-one", "access-token-two"]);
    expect(await getUserById(m)).toBeUndefined();
    expect((await res.json()).plaidRevokeFailed).toBe(0);
  });

  it("one failing revoke does not block the delete and is reported, without the token", async () => {
    const m = await mkUser("m@x.test", "member");
    await mkItem(m, "access-token-one");
    await mkItem(m, "access-token-two");
    __plaidMock.itemRemove
      .mockRejectedValueOnce(new Error("boom access-token-one"))
      .mockResolvedValueOnce({ data: {} });
    const res = await call(m);
    expect(res.status).toBe(200);
    expect((await res.json()).plaidRevokeFailed).toBe(1);
    expect(await getUserById(m)).toBeUndefined();
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls);
    expect(logged).not.toContain("access-token");
  });

  it("inactive items are not revoked again", async () => {
    const m = await mkUser("m@x.test", "member");
    const it1 = await mkItem(m, "access-token-one");
    await deactivatePlaidItem(m, it1.id);
    const res = await call(m);
    expect(res.status).toBe(200);
    expect(__plaidMock.itemRemove).not.toHaveBeenCalled();
  });

  it("a user with no items makes no Plaid call", async () => {
    const m = await mkUser("m@x.test", "member");
    const res = await call(m);
    expect(res.status).toBe(200);
    expect(__plaidMock.itemRemove).not.toHaveBeenCalled();
    expect((await res.json()).plaidRevokeFailed).toBe(0);
  });

  it("Plaid not configured: no throw, user deleted, items counted as unrevoked", async () => {
    plaidConfigured = false;
    const m = await mkUser("m@x.test", "member");
    await mkItem(m, "access-token-one");
    const res = await call(m);
    expect(res.status).toBe(200);
    expect((await res.json()).plaidRevokeFailed).toBe(1);
    expect(await getUserById(m)).toBeUndefined();
  });

  it("deleting the last admin is refused before any Plaid call", async () => {
    // only one admin exists besides... make the target the only admin: caller id is fake
    const db = getDb();
    await db.delete(users).run();
    const sole = await mkUser("sole@x.test", "admin");
    await mkItem(sole, "access-token-one");
    const res = await call(sole);
    expect(res.status).toBe(400);
    expect(__plaidMock.itemRemove).not.toHaveBeenCalled();
    expect(await getUserById(sole)).toBeDefined();
  });
});
