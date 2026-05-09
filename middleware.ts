import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import authConfig from "./auth.config";
import { takeToken } from "./lib/rate-limit";
import { clientIp, hostAllowed, originAllowed } from "./lib/security";

const { auth } = NextAuth(authConfig);

const PUBLIC = new Set<string>(["/login", "/setup"]);
const PUBLIC_PREFIXES = ["/api/auth", "/api/health", "/api/setup", "/_next", "/favicon"];

const CREDENTIALS_CALLBACK = "/api/auth/callback/credentials";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Paths that bypass the Host allowlist. Only liveness checks belong here —
// the Docker healthcheck hits this from inside the container with
// `Host: 127.0.0.1`, which the allowlist would otherwise reject. The route
// itself returns no sensitive data, so a host-header bypass here is safe.
const HOST_CHECK_BYPASS = new Set<string>(["/api/health"]);

export default auth((req) => {
  const { pathname } = req.nextUrl;

  // Block requests whose Host header doesn't match AUTH_URL/APP_URL — defends
  // against cache-poisoning and host-header attacks that would otherwise
  // route absolute URLs (password reset emails, Plaid OAuth redirect) through
  // an attacker-controlled domain.
  if (!HOST_CHECK_BYPASS.has(pathname) && !hostAllowed(req)) {
    return new NextResponse(JSON.stringify({ error: "host not allowed" }), {
      status: 421,
      headers: { "content-type": "application/json" },
    });
  }

  // Origin enforcement on state-changing requests catches simple CSRF where
  // SameSite cookies aren't enough (e.g. an old browser, an extension that
  // injects requests). API routes that legitimately need cross-origin
  // POSTs (none today) would have to be exempted explicitly.
  if (MUTATING_METHODS.has(req.method) && pathname.startsWith("/api/") && !originAllowed(req)) {
    return new NextResponse(JSON.stringify({ error: "origin not allowed" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  // Per-IP login rate limit. The Credentials provider's authorize() callback
  // doesn't have request headers in next-auth v5, so we gate the POST here
  // before NextAuth runs the verifier. Leaky-bucket: 5 attempts, refilling at
  // 0.1/sec (one new attempt every 10s).
  if (req.method === "POST" && pathname === CREDENTIALS_CALLBACK) {
    const ip = clientIp(req);
    const ok = takeToken(`login:${ip}`, { capacity: 5, refillPerSecond: 0.1 });
    if (!ok) {
      return new NextResponse(JSON.stringify({ error: "rate-limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "60" },
      });
    }
  }

  // /api/setup is the highest-impact unauthenticated endpoint — it creates
  // the very first admin and seeds defaults. Throttle creation attempts hard.
  if (req.method === "POST" && pathname === "/api/setup") {
    const ip = clientIp(req);
    const ok = takeToken(`setup:${ip}`, { capacity: 3, refillPerSecond: 0.005 });
    if (!ok) {
      return new NextResponse(JSON.stringify({ error: "rate-limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "120" },
      });
    }
  }

  if (PUBLIC.has(pathname)) return NextResponse.next();
  for (const p of PUBLIC_PREFIXES) {
    if (pathname.startsWith(p)) return NextResponse.next();
  }

  if (!req.auth) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
