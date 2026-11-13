import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";

vi.mock("server-only", () => ({}));

// The module imports repos/plaid-sync/plaid-client transitively; stub them so
// this stays a pure unit test — handler tests inject their own deps anyway.
vi.mock("./repos", () => ({
  getPlaidItemByPlaidItemId: vi.fn(),
  listActivePlaidItemsMissingPlaidItemId: vi.fn(),
  setPlaidItemPlaidItemId: vi.fn(),
  recordPlaidItemError: vi.fn(),
  clearPlaidItemError: vi.fn(),
}));
vi.mock("./plaid-sync", () => ({ syncPlaidTransactions: vi.fn() }));
vi.mock("./plaid-client", () => ({ getPlaidClient: vi.fn() }));
vi.mock("./plaid-crypto", () => ({ decryptToken: vi.fn() }));

import {
  getPlaidWebhookKey,
  handlePlaidWebhook,
  verifyPlaidWebhook,
  type PlaidWebhookJwk,
  type WebhookDeps,
} from "./plaid-webhook";

// ── verification ─────────────────────────────────────────────────────────────

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const { privateKey: strangerKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

const KID = "test-key-1";
const jwk = publicKey.export({ format: "jwk" }) as PlaidWebhookJwk;

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

/** Sign a compact ES256 JWS the way Plaid does. */
function signToken(opts: {
  body: string;
  iat?: number;
  alg?: string;
  kid?: string;
  key?: KeyObject;
  bodySha?: string;
}): string {
  const header = b64url({ alg: opts.alg ?? "ES256", kid: opts.kid ?? KID, typ: "JWT" });
  const payload = b64url({
    iat: opts.iat ?? Math.floor(Date.now() / 1000),
    request_body_sha256:
      opts.bodySha ?? createHash("sha256").update(opts.body, "utf8").digest("hex"),
  });
  const signature = cryptoSign(
    "sha256",
    Buffer.from(`${header}.${payload}`, "utf8"),
    { key: opts.key ?? privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const getKey = async (kid: string): Promise<PlaidWebhookJwk | null> =>
  kid === KID ? jwk : null;

const BODY = JSON.stringify({
  webhook_type: "TRANSACTIONS",
  webhook_code: "SYNC_UPDATES_AVAILABLE",
  item_id: "plaid-item-1",
});

describe("verifyPlaidWebhook", () => {
  it("accepts a valid ES256 token bound to the exact body", async () => {
    const token = signToken({ body: BODY });
    await expect(verifyPlaidWebhook({ rawBody: BODY, token, getKey })).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects when the body was tampered with after signing", async () => {
    const token = signToken({ body: BODY });
    const tampered = BODY.replace("plaid-item-1", "plaid-item-2");
    const result = await verifyPlaidWebhook({ rawBody: tampered, token, getKey });
    expect(result).toEqual({ ok: false, reason: "request body hash mismatch" });
  });

  it("rejects a signature from the wrong key", async () => {
    const token = signToken({ body: BODY, key: strangerKey });
    const result = await verifyPlaidWebhook({ rawBody: BODY, token, getKey });
    expect(result).toEqual({ ok: false, reason: "signature mismatch" });
  });

  it("rejects tokens older than five minutes", async () => {
    const iat = Math.floor(Date.now() / 1000) - 6 * 60;
    const token = signToken({ body: BODY, iat });
    const result = await verifyPlaidWebhook({ rawBody: BODY, token, getKey });
    expect(result).toEqual({ ok: false, reason: "token issued too long ago" });
  });

  it("honors an injected clock for freshness", async () => {
    const iat = 1_700_000_000;
    const token = signToken({ body: BODY, iat });
    await expect(
      verifyPlaidWebhook({ rawBody: BODY, token, getKey, nowMs: (iat + 60) * 1000 }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects any algorithm other than ES256", async () => {
    const token = signToken({ body: BODY, alg: "HS256" });
    const result = await verifyPlaidWebhook({ rawBody: BODY, token, getKey });
    expect(result).toEqual({ ok: false, reason: 'disallowed alg "HS256"' });
  });

  it("rejects an unknown kid", async () => {
    const token = signToken({ body: BODY, kid: "who-dis" });
    const result = await verifyPlaidWebhook({ rawBody: BODY, token, getKey });
    expect(result).toEqual({ ok: false, reason: 'no verification key for kid "who-dis"' });
  });

  it("rejects garbage tokens without throwing", async () => {
    for (const token of ["", "a.b", "not-a-jwt-at-all", "a.b.c.d"]) {
      const result = await verifyPlaidWebhook({ rawBody: BODY, token, getKey });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a wrong-length body hash without leaking timing", async () => {
    const token = signToken({ body: BODY, bodySha: "deadbeef" });
    const result = await verifyPlaidWebhook({ rawBody: BODY, token, getKey });
    expect(result).toEqual({ ok: false, reason: "request body hash mismatch" });
  });
});

// ── handler ──────────────────────────────────────────────────────────────────

type Deferred = { promise: Promise<never>; reject: (e: Error) => void };
function deferred(): Deferred {
  let reject!: (e: Error) => void;
  const promise = new Promise<never>((_, rej) => {
    reject = rej;
  });
  return { promise, reject };
}

/** Let fire-and-forget sync continuations (and any follow-up) run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const ITEM = {
  id: "local-item-1",
  userId: "user-1",
  plaidItemId: "plaid-item-1",
  isActive: true,
  accessTokenEnc: "enc",
  accessTokenIv: "iv",
  accessTokenTag: "tag",
};

function makeDeps(overrides: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
    getItem: vi.fn().mockResolvedValue(ITEM as never),
    listItemsMissingPlaidItemId: vi.fn().mockResolvedValue([]),
    setItemPlaidItemId: vi.fn().mockResolvedValue(undefined),
    resolvePlaidItemId: vi.fn().mockResolvedValue("plaid-item-1"),
    recordItemError: vi.fn().mockResolvedValue(undefined),
    clearItemError: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue({
      added: 1,
      modified: 0,
      removed: 0,
      cardsUpdated: 0,
      statementsCreated: 0,
      statementsReconciled: 0,
      paychecksReconciled: 0,
    }),
    ...overrides,
  };
}

describe("handlePlaidWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("triggers a per-item sync for TRANSACTIONS/SYNC_UPDATES_AVAILABLE", async () => {
    const deps = makeDeps();
    const outcome = await handlePlaidWebhook(
      { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "plaid-item-1" },
      deps,
    );
    expect(outcome).toEqual({ action: "sync-started", itemId: "local-item-1" });
    // Fire-and-forget: give the microtask a beat to run.
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.sync).toHaveBeenCalledWith("user-1", "local-item-1");
  });

  it("ignores non-TRANSACTIONS webhook types without syncing", async () => {
    const deps = makeDeps();
    const outcome = await handlePlaidWebhook(
      { webhook_type: "HOLDINGS", webhook_code: "DEFAULT_UPDATE", item_id: "plaid-item-1" },
      deps,
    );
    expect(outcome).toEqual({ action: "ignored", reason: "unhandled type HOLDINGS" });
    expect(deps.sync).not.toHaveBeenCalled();
  });

  it("ignores unhandled TRANSACTIONS codes", async () => {
    const deps = makeDeps();
    const outcome = await handlePlaidWebhook(
      { webhook_type: "TRANSACTIONS", webhook_code: "RECURRING_TRANSACTIONS_UPDATE", item_id: "x" },
      deps,
    );
    expect(outcome).toEqual({
      action: "ignored",
      reason: "unhandled code RECURRING_TRANSACTIONS_UPDATE",
    });
    expect(deps.sync).not.toHaveBeenCalled();
  });

  it("ignores webhooks whose item_id matches no local item", async () => {
    const deps = makeDeps({ getItem: vi.fn().mockResolvedValue(undefined) });
    const outcome = await handlePlaidWebhook(
      { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "nope" },
      deps,
    );
    expect(outcome).toEqual({ action: "ignored", reason: "unknown item" });
    expect(deps.sync).not.toHaveBeenCalled();
  });

  it("backfills plaid_item_id for legacy items, then matches", async () => {
    const legacy = { ...ITEM, plaidItemId: null };
    const getItem = vi
      .fn()
      .mockResolvedValueOnce(undefined) // direct lookup misses
      .mockResolvedValueOnce(ITEM); // retry after backfill hits
    const deps = makeDeps({
      getItem,
      listItemsMissingPlaidItemId: vi.fn().mockResolvedValue([legacy]),
    });
    const outcome = await handlePlaidWebhook(
      { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "plaid-item-1" },
      deps,
    );
    expect(deps.resolvePlaidItemId).toHaveBeenCalledTimes(1);
    expect(deps.setItemPlaidItemId).toHaveBeenCalledWith("local-item-1", "plaid-item-1");
    expect(outcome).toEqual({ action: "sync-started", itemId: "local-item-1" });
  });

  it("queues a webhook that arrives mid-sync, and a failing sync still runs the follow-up", async () => {
    const gate = deferred();
    const sync = vi.fn().mockImplementation(() => gate.promise);
    const deps = makeDeps({ sync });
    const payload = {
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "plaid-item-1",
    };

    const first = await handlePlaidWebhook(payload, deps);
    const second = await handlePlaidWebhook(payload, deps);
    expect(first).toEqual({ action: "sync-started", itemId: "local-item-1" });
    expect(second).toEqual({ action: "queued", itemId: "local-item-1" });
    expect(sync).toHaveBeenCalledTimes(1);

    // Release the gate as a failure. The queued follow-up must still run (it
    // fails too — same gate), and both failures must clear the item's state.
    gate.reject(new Error("done"));
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);
    const third = await handlePlaidWebhook(payload, deps);
    expect(third).toEqual({ action: "sync-started", itemId: "local-item-1" });
    expect(sync).toHaveBeenCalledTimes(3);
  });
});

// Audit 2026-11-10 PLAID-4. Plaid fires SYNC_UPDATES_AVAILABLE when the
// extraction our own /transactions/refresh asked for completes — often while
// that same sync is still on its balance and liabilities calls, after it has
// already read the cursor. Dropping that webhook left posted rows unread
// while the live balance had already lost the money.
describe("handlePlaidWebhook: webhooks during an in-flight sync", () => {
  type Gate = { resolve: () => void; reject: (e: Error) => void };
  const SYNC_RESULT = {
    added: 0,
    modified: 0,
    removed: 0,
    cardsUpdated: 0,
    statementsCreated: 0,
    statementsReconciled: 0,
    paychecksReconciled: 0,
  };

  // Every gate any test opened, so a failing test cannot leave an item "in
  // flight" in the module's state and break the tests after it.
  let unreleased: Gate[] = [];

  /** A sync mock whose every call stays in flight until its gate is released. */
  function gatedSync() {
    const gates: Gate[] = [];
    const calls: string[] = [];
    const sync = vi.fn((_userId: string, itemId?: string) => {
      calls.push(itemId ?? "");
      return new Promise((resolve, reject) => {
        const gate = { resolve: () => resolve(SYNC_RESULT), reject };
        gates.push(gate);
        unreleased.push(gate);
      });
    });
    return { sync: sync as unknown as WebhookDeps["sync"] & typeof sync, gates, calls };
  }

  const hook = (itemId = "plaid-item-1") => ({
    webhook_type: "TRANSACTIONS",
    webhook_code: "SYNC_UPDATES_AVAILABLE",
    item_id: itemId,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    for (let round = 0; round < 10 && unreleased.length > 0; round++) {
      const open = unreleased;
      unreleased = [];
      for (const gate of open) gate.resolve();
      await flush();
    }
  });

  it("one webhook mid-sync runs exactly one follow-up, after the first sync ends", async () => {
    const { sync, gates } = gatedSync();
    const deps = makeDeps({ sync });

    expect(await handlePlaidWebhook(hook(), deps)).toEqual({
      action: "sync-started",
      itemId: "local-item-1",
    });
    expect(await handlePlaidWebhook(hook(), deps)).toEqual({
      action: "queued",
      itemId: "local-item-1",
    });
    await flush();
    // Never two syncs for one item at once.
    expect(sync).toHaveBeenCalledTimes(1);

    gates[0]!.resolve();
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith("user-1", "local-item-1");

    gates[1]!.resolve();
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("any number of webhooks during one sync still produce one follow-up", async () => {
    const { sync, gates } = gatedSync();
    const deps = makeDeps({ sync });

    await handlePlaidWebhook(hook(), deps);
    for (let i = 0; i < 3; i++) {
      expect((await handlePlaidWebhook(hook(), deps)).action).toBe("queued");
    }
    gates[0]!.resolve();
    await flush();
    gates[1]!.resolve();
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("a webhook during the follow-up produces one more sync", async () => {
    const { sync, gates } = gatedSync();
    const deps = makeDeps({ sync });

    await handlePlaidWebhook(hook(), deps);
    await handlePlaidWebhook(hook(), deps);
    gates[0]!.resolve();
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);

    expect((await handlePlaidWebhook(hook(), deps)).action).toBe("queued");
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);
    gates[1]!.resolve();
    await flush();
    expect(sync).toHaveBeenCalledTimes(3);
    gates[2]!.resolve();
    await flush();
    expect(sync).toHaveBeenCalledTimes(3);

    // Everything drained: the next webhook starts a fresh sync.
    expect((await handlePlaidWebhook(hook(), deps)).action).toBe("sync-started");
    expect(sync).toHaveBeenCalledTimes(4);
    gates[3]!.resolve();
    await flush();
  });

  it("a rejected in-flight sync still runs the follow-up, then the item is idle again", async () => {
    const { sync, gates } = gatedSync();
    const deps = makeDeps({ sync });

    await handlePlaidWebhook(hook(), deps);
    await handlePlaidWebhook(hook(), deps);
    gates[0]!.reject(new Error("ITEM_LOGIN_REQUIRED"));
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);

    gates[1]!.resolve();
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);
    expect((await handlePlaidWebhook(hook(), deps)).action).toBe("sync-started");
    expect(sync).toHaveBeenCalledTimes(3);
    gates[2]!.resolve();
    await flush();
  });

  it("webhooks for two different items neither block nor dirty each other", async () => {
    const { sync, gates, calls } = gatedSync();
    const ITEM_B = { ...ITEM, id: "local-item-2", plaidItemId: "plaid-item-2" };
    const getItem = vi.fn(async (plaidItemId: string) =>
      plaidItemId === "plaid-item-2" ? ITEM_B : ITEM,
    );
    const deps = makeDeps({ sync, getItem: getItem as unknown as WebhookDeps["getItem"] });

    expect(await handlePlaidWebhook(hook("plaid-item-1"), deps)).toEqual({
      action: "sync-started",
      itemId: "local-item-1",
    });
    expect(await handlePlaidWebhook(hook("plaid-item-2"), deps)).toEqual({
      action: "sync-started",
      itemId: "local-item-2",
    });
    expect(calls).toEqual(["local-item-1", "local-item-2"]);

    // Ending both runs must not trigger a follow-up for either.
    gates[0]!.resolve();
    gates[1]!.resolve();
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);

    // A webhook mid-sync for item 2 queues only item 2.
    await handlePlaidWebhook(hook("plaid-item-1"), deps);
    await handlePlaidWebhook(hook("plaid-item-2"), deps);
    expect((await handlePlaidWebhook(hook("plaid-item-2"), deps)).action).toBe("queued");
    gates[2]!.resolve(); // item 1 ends: no follow-up for it
    await flush();
    expect(calls).toEqual(["local-item-1", "local-item-2", "local-item-1", "local-item-2"]);
    gates[3]!.resolve(); // item 2 ends: its follow-up runs
    await flush();
    expect(calls).toEqual([
      "local-item-1",
      "local-item-2",
      "local-item-1",
      "local-item-2",
      "local-item-2",
    ]);
    gates[4]!.resolve();
    await flush();
    expect(sync).toHaveBeenCalledTimes(5);
  });

  it("runs no follow-up when no webhook arrived mid-sync", async () => {
    const { sync, gates } = gatedSync();
    const deps = makeDeps({ sync });

    await handlePlaidWebhook(hook(), deps);
    gates[0]!.resolve();
    await flush();
    await flush();
    expect(sync).toHaveBeenCalledTimes(1);
    expect((await handlePlaidWebhook(hook(), deps)).action).toBe("sync-started");
    expect(sync).toHaveBeenCalledTimes(2);
    gates[1]!.resolve();
    await flush();
  });

  it("a sync that throws synchronously does not leave the item stuck in flight", async () => {
    const sync = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockResolvedValue(SYNC_RESULT);
    const deps = makeDeps({ sync });

    expect((await handlePlaidWebhook(hook(), deps)).action).toBe("sync-started");
    await flush();
    expect((await handlePlaidWebhook(hook(), deps)).action).toBe("sync-started");
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);
  });
});

// Review 2026-09-24 C12.
// Review 2026-11-10 PLAID-2: every ITEM webhook used to be ignored, so Plaid
// telling us a login broke (or would soon expire) changed nothing anywhere.
describe("handlePlaidWebhook: ITEM health webhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ERROR stores the code from the payload for that item only, and does not sync", async () => {
    const deps = makeDeps();
    const outcome = await handlePlaidWebhook(
      {
        webhook_type: "ITEM",
        webhook_code: "ERROR",
        item_id: "plaid-item-1",
        error: { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", error_message: "x" },
      },
      deps,
    );
    expect(outcome).toEqual({
      action: "health-updated",
      itemId: "local-item-1",
      code: "ITEM_LOGIN_REQUIRED",
    });
    expect(deps.recordItemError).toHaveBeenCalledTimes(1);
    expect(deps.recordItemError).toHaveBeenCalledWith(
      "user-1",
      "local-item-1",
      "ITEM_LOGIN_REQUIRED",
      expect.any(Number),
    );
    expect(deps.clearItemError).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.sync).not.toHaveBeenCalled();
  });

  it("ERROR with no usable code stores UNKNOWN_ERROR, never free text", async () => {
    const deps = makeDeps();
    await handlePlaidWebhook(
      {
        webhook_type: "ITEM",
        webhook_code: "ERROR",
        item_id: "plaid-item-1",
        error: { error_code: "access-production-abc token here" },
      },
      deps,
    );
    expect(deps.recordItemError).toHaveBeenCalledWith(
      "user-1",
      "local-item-1",
      "UNKNOWN_ERROR",
      expect.any(Number),
    );
  });

  it.each(["PENDING_EXPIRATION", "PENDING_DISCONNECT", "USER_PERMISSION_REVOKED"])(
    "%s stores its own code (needs re-authentication)",
    async (code) => {
      const deps = makeDeps();
      const outcome = await handlePlaidWebhook(
        { webhook_type: "ITEM", webhook_code: code, item_id: "plaid-item-1" },
        deps,
      );
      expect(outcome).toEqual({ action: "health-updated", itemId: "local-item-1", code });
      expect(deps.recordItemError).toHaveBeenCalledWith(
        "user-1",
        "local-item-1",
        code,
        expect.any(Number),
      );
      expect(deps.sync).not.toHaveBeenCalled();
    },
  );

  it("LOGIN_REPAIRED clears the error, including a pending warning", async () => {
    const deps = makeDeps();
    const outcome = await handlePlaidWebhook(
      { webhook_type: "ITEM", webhook_code: "LOGIN_REPAIRED", item_id: "plaid-item-1" },
      deps,
    );
    expect(outcome).toEqual({ action: "health-updated", itemId: "local-item-1", code: null });
    expect(deps.clearItemError).toHaveBeenCalledWith("user-1", "local-item-1", {
      keepPending: false,
    });
    expect(deps.recordItemError).not.toHaveBeenCalled();
  });

  it("other ITEM codes stay ignored and write nothing", async () => {
    const deps = makeDeps();
    const outcome = await handlePlaidWebhook(
      { webhook_type: "ITEM", webhook_code: "NEW_ACCOUNTS_AVAILABLE", item_id: "plaid-item-1" },
      deps,
    );
    expect(outcome).toEqual({ action: "ignored", reason: "unhandled code NEW_ACCOUNTS_AVAILABLE" });
    expect(deps.getItem).not.toHaveBeenCalled();
    expect(deps.recordItemError).not.toHaveBeenCalled();
    expect(deps.clearItemError).not.toHaveBeenCalled();
  });

  it("an ITEM webhook for an unknown item writes nothing", async () => {
    const deps = makeDeps({ getItem: vi.fn().mockResolvedValue(undefined) });
    const outcome = await handlePlaidWebhook(
      {
        webhook_type: "ITEM",
        webhook_code: "ERROR",
        item_id: "nope",
        error: { error_code: "ITEM_LOGIN_REQUIRED" },
      },
      deps,
    );
    expect(outcome).toEqual({ action: "ignored", reason: "unknown item" });
    expect(deps.recordItemError).not.toHaveBeenCalled();
    expect(deps.clearItemError).not.toHaveBeenCalled();
  });

  it("only the item the payload names is touched: another user's item cannot be reached", async () => {
    const otherUsersItem = { ...ITEM, id: "local-item-2", userId: "user-2", plaidItemId: "plaid-item-2" };
    const getItem = vi.fn(async (plaidItemId: string) =>
      plaidItemId === "plaid-item-2" ? otherUsersItem : plaidItemId === "plaid-item-1" ? ITEM : undefined,
    );
    const deps = makeDeps({ getItem: getItem as never });
    await handlePlaidWebhook(
      {
        webhook_type: "ITEM",
        webhook_code: "ERROR",
        item_id: "plaid-item-1",
        // Extra fields in the body cannot redirect the write.
        user_id: "user-2",
        local_item_id: "local-item-2",
        error: { error_code: "ITEM_LOGIN_REQUIRED" },
      },
      deps,
    );
    expect(getItem).toHaveBeenCalledWith("plaid-item-1");
    expect(deps.recordItemError).toHaveBeenCalledTimes(1);
    expect(deps.recordItemError).toHaveBeenCalledWith(
      "user-1",
      "local-item-1",
      "ITEM_LOGIN_REQUIRED",
      expect.any(Number),
    );
  });
});

describe("webhook key hygiene", () => {
  it("rejects a token signed with a key Plaid has expired", async () => {
    const now = Date.now();
    const expired = { ...jwk, expired_at: Math.floor(now / 1000) - 60 };
    const token = signToken({ body: BODY });
    await expect(
      verifyPlaidWebhook({ rawBody: BODY, token, getKey: async () => expired, nowMs: now }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
  });

  it("still accepts a key whose expiry is in the future", async () => {
    const now = Date.now();
    const expiring = { ...jwk, expired_at: Math.floor(now / 1000) + 3600 };
    const token = signToken({ body: BODY });
    await expect(
      verifyPlaidWebhook({ rawBody: BODY, token, getKey: async () => expiring, nowMs: now }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects a token issued in the future, allowing a minute of clock skew", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const skewed = signToken({ body: BODY, iat: nowSec + 30 });
    await expect(verifyPlaidWebhook({ rawBody: BODY, token: skewed, getKey })).resolves.toEqual({ ok: true });
    const future = signToken({ body: BODY, iat: nowSec + 3600 });
    await expect(verifyPlaidWebhook({ rawBody: BODY, token: future, getKey })).resolves.toMatchObject({
      ok: false,
      reason: "token issued in the future",
    });
  });

  it("asks Plaid about an unknown kid once, then again only after five minutes", async () => {
    const fetchKey = vi.fn(async () => {
      throw new Error("INVALID_KEY_ID");
    });
    const kid = `made-up-${Math.random()}`;
    const t0 = 1_800_000_000_000;
    expect(await getPlaidWebhookKey(kid, { fetchKey, nowMs: t0 })).toBeNull();
    expect(await getPlaidWebhookKey(kid, { fetchKey, nowMs: t0 + 60_000 })).toBeNull();
    expect(fetchKey).toHaveBeenCalledTimes(1);
    expect(await getPlaidWebhookKey(kid, { fetchKey, nowMs: t0 + 5 * 60_000 + 1 })).toBeNull();
    expect(fetchKey).toHaveBeenCalledTimes(2);
  });

  it("caches a found key", async () => {
    const fetchKey = vi.fn(async () => jwk);
    const kid = `real-${Math.random()}`;
    expect(await getPlaidWebhookKey(kid, { fetchKey })).toEqual(jwk);
    expect(await getPlaidWebhookKey(kid, { fetchKey })).toEqual(jwk);
    expect(fetchKey).toHaveBeenCalledTimes(1);
  });

});
