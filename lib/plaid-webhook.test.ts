import { beforeEach, describe, expect, it, vi } from "vitest";
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
}));
vi.mock("./plaid-sync", () => ({ syncPlaidTransactions: vi.fn() }));
vi.mock("./plaid-client", () => ({ getPlaidClient: vi.fn() }));
vi.mock("./plaid-crypto", () => ({ decryptToken: vi.fn() }));

import {
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
      { webhook_type: "ITEM", webhook_code: "ERROR", item_id: "plaid-item-1" },
      deps,
    );
    expect(outcome).toEqual({ action: "ignored", reason: "unhandled type ITEM" });
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

  it("coalesces a second webhook while a sync for the same item is in flight", async () => {
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
    expect(second).toEqual({ action: "coalesced", itemId: "local-item-1" });
    expect(sync).toHaveBeenCalledTimes(1);

    // Release the gate (as a failure — also proves errors clear the lock).
    gate.reject(new Error("done"));
    await new Promise((r) => setTimeout(r, 0));
    const third = await handlePlaidWebhook(payload, deps);
    expect(third).toEqual({ action: "sync-started", itemId: "local-item-1" });
    expect(sync).toHaveBeenCalledTimes(2);
  });
});
