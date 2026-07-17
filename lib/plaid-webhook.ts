import "server-only";
import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";
import { getPlaidClient } from "./plaid-client";
import { decryptToken } from "./plaid-crypto";
import {
  getPlaidItemByPlaidItemId,
  listActivePlaidItemsMissingPlaidItemId,
  setPlaidItemPlaidItemId,
} from "./repos";
import { syncPlaidTransactions } from "./plaid-sync";
import type { PlaidWebhookInput } from "./validation";
import { log } from "./log";

/**
 * Plaid webhook verification per https://plaid.com/docs/api/webhooks/webhook-verification/:
 * every webhook POST carries a `plaid-verification` header holding a compact
 * JWS (ES256). The JWT payload binds the request body via
 * `request_body_sha256`; the signing key is fetched from Plaid by `kid` and
 * cached. Verification is implemented with node:crypto — no JWT library —
 * because ES256-verify of a compact JWS is small and the repo avoids new
 * dependencies.
 */

/** Shape of the JWK returned by Plaid's /webhook_verification_key/get. */
export type PlaidWebhookJwk = {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  use?: string;
  alg?: string;
  kid?: string;
  created_at?: number;
  expired_at?: number | null;
};

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** Plaid signs with a 5-minute freshness window; reject anything older. */
const MAX_TOKEN_AGE_SECONDS = 5 * 60;

function b64urlJson(part: string): unknown | null {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Verify a Plaid webhook's `plaid-verification` JWT against the raw request
 * body. Pure apart from the injected key fetcher, so tests can sign with
 * their own ES256 keypair.
 */
export async function verifyPlaidWebhook(opts: {
  rawBody: string;
  token: string;
  getKey: (kid: string) => Promise<PlaidWebhookJwk | null>;
  nowMs?: number;
}): Promise<VerifyResult> {
  const parts = opts.token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed JWT" };
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = b64urlJson(headerB64) as { alg?: string; kid?: string } | null;
  if (!header) return { ok: false, reason: "unparseable JWT header" };
  // Pinning the algorithm defeats alg-substitution attacks ("none", HS256
  // with the public key as HMAC secret, etc.). Plaid only ever uses ES256.
  if (header.alg !== "ES256") return { ok: false, reason: `disallowed alg "${header.alg}"` };
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    return { ok: false, reason: "missing kid" };
  }

  const jwk = await opts.getKey(header.kid);
  if (!jwk) return { ok: false, reason: `no verification key for kid "${header.kid}"` };

  let publicKey;
  try {
    publicKey = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
  } catch {
    return { ok: false, reason: "invalid verification key" };
  }

  // JWS ES256 signatures are raw r||s (IEEE P1363), not DER.
  let signatureValid = false;
  try {
    signatureValid = cryptoVerify(
      "sha256",
      Buffer.from(`${headerB64}.${payloadB64}`, "utf8"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signatureB64, "base64url"),
    );
  } catch {
    return { ok: false, reason: "signature verification error" };
  }
  if (!signatureValid) return { ok: false, reason: "signature mismatch" };

  const payload = b64urlJson(payloadB64) as
    | { iat?: number; request_body_sha256?: string }
    | null;
  if (!payload) return { ok: false, reason: "unparseable JWT payload" };

  const nowSec = (opts.nowMs ?? Date.now()) / 1000;
  if (typeof payload.iat !== "number" || nowSec - payload.iat > MAX_TOKEN_AGE_SECONDS) {
    return { ok: false, reason: "token issued too long ago" };
  }

  const actual = createHash("sha256").update(opts.rawBody, "utf8").digest("hex");
  const claimed = String(payload.request_body_sha256 ?? "");
  const actualBuf = Buffer.from(actual, "utf8");
  const claimedBuf = Buffer.from(claimed, "utf8");
  if (actualBuf.length !== claimedBuf.length || !timingSafeEqual(actualBuf, claimedBuf)) {
    return { ok: false, reason: "request body hash mismatch" };
  }

  return { ok: true };
}

/**
 * kid → JWK cache. Keys live for the process lifetime; Plaid rotates by
 * introducing a new kid (which misses the cache and triggers a fetch), so
 * stale entries are harmless — they simply stop being asked for.
 */
const keyCache = new Map<string, PlaidWebhookJwk>();

export async function getPlaidWebhookKey(kid: string): Promise<PlaidWebhookJwk | null> {
  const cached = keyCache.get(kid);
  if (cached) return cached;
  try {
    const plaid = getPlaidClient();
    const resp = await plaid.webhookVerificationKeyGet({ key_id: kid });
    const key = resp.data.key as PlaidWebhookJwk;
    keyCache.set(kid, key);
    return key;
  } catch (err) {
    log.warn(`plaid-webhook: verification key fetch failed for kid ${kid}: ${(err as Error).message}`);
    return null;
  }
}

/** Transaction webhook codes that mean "new data is ready — pull it". */
const SYNC_TRIGGER_CODES = new Set([
  "SYNC_UPDATES_AVAILABLE",
  "INITIAL_UPDATE",
  "HISTORICAL_UPDATE",
]);

/**
 * One sync per item at a time. Plaid can burst several webhooks for the same
 * item; the cursor-based sync is idempotent but running it concurrently
 * against the same cursor does redundant work, so extra triggers coalesce
 * into the in-flight run.
 */
const syncInFlight = new Set<string>();

export type WebhookDeps = {
  getItem: typeof getPlaidItemByPlaidItemId;
  listItemsMissingPlaidItemId: typeof listActivePlaidItemsMissingPlaidItemId;
  setItemPlaidItemId: typeof setPlaidItemPlaidItemId;
  resolvePlaidItemId: (item: {
    accessTokenEnc: string;
    accessTokenIv: string;
    accessTokenTag: string;
  }) => Promise<string>;
  sync: typeof syncPlaidTransactions;
};

async function defaultResolvePlaidItemId(item: {
  accessTokenEnc: string;
  accessTokenIv: string;
  accessTokenTag: string;
}): Promise<string> {
  const plaid = getPlaidClient();
  const accessToken = decryptToken(item.accessTokenEnc, item.accessTokenIv, item.accessTokenTag);
  const resp = await plaid.itemGet({ access_token: accessToken });
  return resp.data.item.item_id;
}

const defaultDeps: WebhookDeps = {
  getItem: getPlaidItemByPlaidItemId,
  listItemsMissingPlaidItemId: listActivePlaidItemsMissingPlaidItemId,
  setItemPlaidItemId: setPlaidItemPlaidItemId,
  resolvePlaidItemId: defaultResolvePlaidItemId,
  sync: syncPlaidTransactions,
};

/**
 * Map a Plaid item_id to a local item row. Items linked before migration
 * 0032 have no stored plaid_item_id — backfill them all (each needs exactly
 * one /item/get, ever), then retry the match.
 */
async function resolveItem(plaidItemId: string, deps: WebhookDeps) {
  const direct = await deps.getItem(plaidItemId);
  if (direct) return direct;

  const missing = await deps.listItemsMissingPlaidItemId();
  for (const item of missing) {
    try {
      const realId = await deps.resolvePlaidItemId(item);
      await deps.setItemPlaidItemId(item.id, realId);
    } catch (err) {
      log.warn(`plaid-webhook: item_id backfill failed for item ${item.id}: ${(err as Error).message}`);
    }
  }
  return deps.getItem(plaidItemId);
}

export type WebhookOutcome =
  | { action: "sync-started"; itemId: string }
  | { action: "coalesced"; itemId: string }
  | { action: "ignored"; reason: string };

/**
 * Act on an already-verified webhook payload. Sync runs fire-and-forget so
 * the route can 200 immediately (Plaid retries slow responders); the deploy
 * is a long-running server, not serverless, so the continuation survives the
 * response.
 */
export async function handlePlaidWebhook(
  payload: PlaidWebhookInput,
  deps: WebhookDeps = defaultDeps,
): Promise<WebhookOutcome> {
  if (payload.webhook_type !== "TRANSACTIONS") {
    log.info(`plaid-webhook: ignoring ${payload.webhook_type}/${payload.webhook_code}`);
    return { action: "ignored", reason: `unhandled type ${payload.webhook_type}` };
  }
  if (!SYNC_TRIGGER_CODES.has(payload.webhook_code)) {
    log.info(`plaid-webhook: ignoring TRANSACTIONS/${payload.webhook_code}`);
    return { action: "ignored", reason: `unhandled code ${payload.webhook_code}` };
  }
  if (!payload.item_id) {
    return { action: "ignored", reason: "missing item_id" };
  }

  const item = await resolveItem(payload.item_id, deps);
  if (!item) {
    log.warn(`plaid-webhook: no active item matches plaid item_id ${payload.item_id}`);
    return { action: "ignored", reason: "unknown item" };
  }

  if (syncInFlight.has(item.id)) {
    return { action: "coalesced", itemId: item.id };
  }
  syncInFlight.add(item.id);
  void deps
    .sync(item.userId, item.id)
    .then((r) =>
      log.info(
        `plaid-webhook: synced item ${item.id}: +${r.added} ~${r.modified} -${r.removed}`,
      ),
    )
    .catch((err) =>
      log.error(`plaid-webhook: sync failed for item ${item.id}: ${(err as Error).message}`),
    )
    .finally(() => syncInFlight.delete(item.id));

  return { action: "sync-started", itemId: item.id };
}
