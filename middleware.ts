import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import authConfig from "./auth.config";

const { auth } = NextAuth(authConfig);

const PUBLIC = new Set<string>(["/login", "/setup"]);
const PUBLIC_PREFIXES = ["/api/auth", "/api/health", "/api/setup", "/_next", "/favicon"];

export default auth((req) => {
  const { pathname } = req.nextUrl;

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
