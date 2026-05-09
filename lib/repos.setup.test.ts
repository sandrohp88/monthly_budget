import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

vi.mock("./auth", () => ({
  hashPassword: async (p: string) => `mock-hash-${p}`,
}));

import { __resetDbCacheForTests, getDb, runMigrations } from "./db/client";
import { users } from "./db/schema";
import { createOwnerAndDefaults, OwnerAlreadyExistsError } from "./repos";

let dbDir: string;
beforeEach(() => {
  __resetDbCacheForTests();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-setup-"));
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

const setupInput = {
  startingBalanceCents: 0,
  defaultPaycheckCents: 100_00,
  firstPaydayDate: "2026-05-15",
  payFrequencyDays: 14,
  projectionMonths: 6,
  currency: "USD",
  timezone: "America/New_York",
};

describe("createOwnerAndDefaults / race safety", () => {
  it("creates exactly one user on the first call", async () => {
    const u = await createOwnerAndDefaults({
      ...setupInput,
      email: "owner@example.com",
      password: "supersecret",
      displayName: "Owner",
    });
    expect(u.role).toBe("admin");
    const all = await getDb().select().from(users).all();
    expect(all).toHaveLength(1);
  });

  it("throws OwnerAlreadyExistsError on the second call (different email)", async () => {
    await createOwnerAndDefaults({
      ...setupInput,
      email: "first@example.com",
      password: "supersecret",
      displayName: "First",
    });
    await expect(
      createOwnerAndDefaults({
        ...setupInput,
        email: "second@example.com",
        password: "anothersecret",
        displayName: "Second",
      }),
    ).rejects.toBeInstanceOf(OwnerAlreadyExistsError);

    const all = await getDb().select().from(users).all();
    expect(all).toHaveLength(1);
    expect(all[0]?.email).toBe("first@example.com");
  });

  it("two concurrent callers — only one wins, only one user exists", async () => {
    const a = createOwnerAndDefaults({
      ...setupInput,
      email: "a@example.com",
      password: "secret-a",
      displayName: "A",
    });
    const b = createOwnerAndDefaults({
      ...setupInput,
      email: "b@example.com",
      password: "secret-b",
      displayName: "B",
    });
    const results = await Promise.allSettled([a, b]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(OwnerAlreadyExistsError);

    const all = await getDb().select().from(users).all();
    expect(all).toHaveLength(1);
  });
});
