import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import * as React from "react";

const auth = vi.hoisted(() => ({ userId: "" }));
vi.mock("./auth", () => ({
  hashPassword: async (p: string) => `mock-hash-${p}`,
  getCurrentUserId: async () => auth.userId,
  requirePageUser: async () => ({ id: auth.userId }),
}));
// Inspect the server component's props without loading the browser UI.
vi.mock("@/app/(app)/accounts/accounts-client", () => ({
  AccountsClient: () => null,
}));

import { __resetDbCacheForTests, getDb, runMigrations } from "./db/client";
import { users, type PlaidItemRow } from "./db/schema";
import { newId } from "./ids";
import {
  createPlaidItem,
  getPlaidItem,
  listPlaidItems,
  listPlaidAccountsByItem,
  upsertPlaidAccount,
} from "./repos";
import AccountsPage from "@/app/(app)/accounts/page";
import { GET } from "@/app/api/plaid/items/route";

let dbDir: string;
let item: PlaidItemRow;

beforeEach(async () => {
  __resetDbCacheForTests();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-public-items-"));
  vi.stubEnv("DATABASE_URL", `file:${path.join(dbDir, "test.db")}`);
  // Vitest's JSX transform uses the classic React runtime.
  vi.stubGlobal("React", React);
  getDb();
  runMigrations();
  auth.userId = newId();
  await getDb().insert(users).values({
    id: auth.userId,
    email: "public-items@example.com",
    passwordHash: "x".repeat(64),
    displayName: "Tester",
  }).run();
  item = await createPlaidItem(auth.userId, {
    institutionId: "ins_test",
    institutionName: "Test Bank",
    accessTokenEnc: "test-ciphertext",
    accessTokenIv: "test-iv",
    accessTokenTag: "test-auth-tag",
    cursor: "test-cursor",
    lastSyncedAt: 1_800_000_000_000,
    balanceRefreshedAt: 1_800_000_000_001,
    transactionsRefreshedAt: 1_800_000_000_002,
    lastErrorCode: "ITEM_LOGIN_REQUIRED",
    lastErrorAt: 1_800_000_000_004,
    firstErrorAt: 1_800_000_000_003,
    plaidItemId: "plaid-test-item",
    isActive: true,
  });
  await upsertPlaidAccount({
    id: "test-account",
    userId: auth.userId,
    itemId: item.id,
    name: "Checking",
    type: "depository",
    subtype: "checking",
    mask: "1234",
    balanceCents: 12_345,
    useAsStartingBalance: true,
    syncEnabled: true,
  });
});

afterEach(() => {
  __resetDbCacheForTests();
  fs.rmSync(dbDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("public Plaid items", () => {
  it.each(["Accounts page props", "GET /api/plaid/items JSON"])(
    "%s excludes token ciphertext, IV and tag while preserving other fields",
    async (caller) => {
      let sent: unknown;
      if (caller === "Accounts page props") {
        const page = await AccountsPage();
        sent = page.props.initialItems;
      } else {
        const response = await GET();
        expect(response.status).toBe(200);
        sent = (await response.json()).items;
      }

      expect(sent).toHaveLength(1);
      const publicItem = (sent as Record<string, unknown>[])[0]!;
      const secretKeys = ["accessTokenEnc", "accessTokenIv", "accessTokenTag"];
      for (const key of secretKeys) {
        expect(publicItem).not.toHaveProperty(key);
        expect(JSON.stringify(sent)).not.toContain(item[key as keyof PlaidItemRow]);
      }
      const nonSecretFields = Object.fromEntries(
        Object.entries(item).filter(([key]) => !secretKeys.includes(key)),
      );
      expect(publicItem).toEqual({
        ...nonSecretFields,
        accounts: await listPlaidAccountsByItem(item.id),
      });
      // Sync and item removal still receive the full server-only row.
      expect(await listPlaidItems(auth.userId)).toEqual([item]);
      expect(await getPlaidItem(auth.userId, item.id)).toEqual(item);
    },
  );
});
