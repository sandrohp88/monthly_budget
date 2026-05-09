/**
 * Shared HTTP security helpers — IP attribution, host/origin allowlisting,
 * and request-id minting. The middleware and a few specific routes (setup,
 * mutating endpoints) all need the same answers here, so the logic lives in
 * one place.
 *
 * Trust model:
 *   - Behind Caddy on the LAN, x-forwarded-for is set ONLY by Caddy because
 *     the Caddyfile uses `request_header -X-Forwarded-For` to drop any header
 *     the upstream client tried to send before re-adding the trusted hop.
 *   - In dev (`npm run dev`), there is no proxy so the request socket address
 *     is the real client and we fall back to `unknown`.
 *
 *   These helpers MUST NOT trust `x-forwarded-for` blindly when no proxy is
 *   in front of Next — see `clientIp` for the env-gated logic.
 */
/** Comma-separated list of proxy hops the app trusts (defaults to "1" hop). */
function trustedProxyHops(): number {
  const raw = process.env.TRUST_PROXY_HOPS;
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 1;
  return n;
}

/**
 * Pull the originating client IP out of the request. With one trusted proxy
 * hop (the default — Caddy in our deploy), we take the rightmost entry of
 * `x-forwarded-for` (the IP the trusted proxy observed). With N trusted
 * hops, we walk N entries from the right. With zero hops, we ignore
 * `x-forwarded-for` entirely so a hostile client can't spoof their IP via
 * a self-set header.
 *
 * Falls back to a literal "unknown" so the rate limiter still has a stable
 * key per process.
 */
export function clientIp(req: Request): string {
  const hops = trustedProxyHops();
  if (hops > 0) {
    // Caddy strips/rewrites x-forwarded-for; we trust only the rightmost
    // `hops` entries. The leftmost (untrusted) hops are whatever the original
    // client claimed and must not be used for rate limiting.
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) {
        const idx = Math.max(0, parts.length - hops);
        const candidate = parts[idx];
        if (candidate) return candidate;
      }
    }
    const real = req.headers.get("x-real-ip")?.trim();
    if (real) return real;
  }
  return "unknown";
}

/**
 * Hosts the app will accept. Derived from AUTH_URL / APP_URL — the deploy
 * MUST set at least one of these to enforce the check. In dev, when neither
 * is set, we accept the literal `localhost*` family so `npm run dev` keeps
 * working.
 */
function allowedHosts(): Set<string> | null {
  const out = new Set<string>();
  const env = (process.env.AUTH_URL ?? "") + " " + (process.env.APP_URL ?? "");
  for (const raw of env.split(/\s+/).filter(Boolean)) {
    try {
      const u = new URL(raw);
      out.add(u.host);
    } catch {
      // ignore malformed env values; the app boots either way
    }
  }
  if (out.size === 0) {
    if (process.env.NODE_ENV !== "production") {
      return null; // dev: don't enforce
    }
    return out; // prod with no env set → empty set blocks everything; deploy issue
  }
  return out;
}

/** Allow if the request's Host header matches an allowed host. */
export function hostAllowed(req: Request): boolean {
  const allowed = allowedHosts();
  if (allowed === null) return true; // dev escape hatch only
  const host = req.headers.get("host");
  if (!host) return false;
  return allowed.has(host);
}

/**
 * For state-changing requests (POST/PUT/PATCH/DELETE), require an Origin
 * header AND require it to match an allowed host. Browsers always send
 * Origin on cross-site fetches, so a missing/mismatched Origin is a strong
 * CSRF signal even with SameSite cookies in place.
 *
 * Returns `true` if safe; `false` to reject. Same-origin GET/HEAD/OPTIONS
 * are trivially allowed (no body, no side effects).
 */
export function originAllowed(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;

  const allowed = allowedHosts();
  if (allowed === null) return true; // dev only

  const origin = req.headers.get("origin");
  if (!origin) {
    // Some legitimate non-browser clients (curl, mobile apps) skip Origin.
    // Fall back to host so we still have *some* binding.
    return hostAllowed(req);
  }
  try {
    const u = new URL(origin);
    return allowed.has(u.host);
  } catch {
    return false;
  }
}

/**
 * Short, opaque request id used to correlate sanitized client errors with
 * server logs. Implemented via the Web Crypto API so this module stays
 * Edge-compatible (the middleware imports it).
 */
export function newRequestId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
