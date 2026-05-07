import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import authConfig from "./auth.config";
import { takeToken } from "./lib/rate-limit";

const { auth } = NextAuth(authConfig);

const PUBLIC = new Set<string>(["/login", "/setup"]);
const PUBLIC_PREFIXES = ["/api/auth", "/api/health", "/api/setup", "/_next", "/favicon"];

const CREDENTIALS_CALLBACK = "/api/auth/callback/credentials";

/**
 * Pull the originating client IP out of the request. We trust the leftmost
 * x-forwarded-for hop (Caddy sets this in our deploy), and fall back to a
 * literal "unknown" so the rate limiter still has a stable key per process.
 */
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

export default auth((req) => {
  const { pathname } = req.nextUrl;

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
