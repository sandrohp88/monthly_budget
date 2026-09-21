import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("./auth", () => ({
  hashPassword: async (p: string) => `mock-hash-${p}`,
}));

import { __resetDbCacheForTests, getDb, runMigrations } from "./db/client";
import { users } from "./db/schema";
import { deleteUser, updateUserPassword, updateUserProfile } from "./repos";
import { resolveSessionUser } from "./session-user";
import authConfig from "../auth.config";

// Review 2026-09-21 R05: a signed, unexpired JWT used to keep full access —
// including admin — after the user was demoted, deleted, or changed password.

let dir: string;
beforeEach(() => {
  __resetDbCacheForTests();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-session-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  runMigrations();
  getDb()
    .insert(users)
    .values({ id: "u", email: "a@example.com", passwordHash: "x", displayName: "A", role: "admin" })
    .run();
});
afterEach(() => {
  __resetDbCacheForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveSessionUser", () => {
  it("resolves a current token to the live user", () => {
    expect(resolveSessionUser({ id: "u", sv: 0 })).toEqual({
      id: "u",
      email: "a@example.com",
      displayName: "A",
      role: "admin",
    });
  });

  it("accepts tokens issued before session versions existed", () => {
    expect(resolveSessionUser({ id: "u" })?.id).toBe("u");
  });

  it("rejects missing claims", () => {
    expect(resolveSessionUser(null)).toBeNull();
    expect(resolveSessionUser({})).toBeNull();
  });

  it("rejects a deleted user's token", async () => {
    await deleteUser("u");
    expect(resolveSessionUser({ id: "u", sv: 0 })).toBeNull();
  });

  it("revokes existing sessions on demotion", async () => {
    await updateUserProfile("u", { role: "member" });
    expect(resolveSessionUser({ id: "u", sv: 0 })).toBeNull();
    expect(resolveSessionUser({ id: "u", sv: 1 })?.role).toBe("member");
  });

  it("revokes existing sessions on password change", async () => {
    await updateUserPassword("u", "a-new-password");
    expect(resolveSessionUser({ id: "u", sv: 0 })).toBeNull();
    expect(resolveSessionUser({ id: "u", sv: 1 })?.id).toBe("u");
  });

  it("does not revoke on a display-name edit or a no-op role write", async () => {
    await updateUserProfile("u", { displayName: "Renamed", role: "admin" });
    expect(resolveSessionUser({ id: "u", sv: 0 })?.displayName).toBe("Renamed");
  });
});

describe("JWT callback", () => {
  it("records the session version and never the role", async () => {
    const token = await authConfig.callbacks.jwt({
      token: { role: "admin" },
      user: { id: "u", sessionVersion: 3 },
    } as never);
    expect(token).toMatchObject({ uid: "u", sv: 3 });
    expect(token).not.toHaveProperty("role");
  });
});
