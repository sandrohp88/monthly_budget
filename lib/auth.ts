import { cache } from "react";
import { redirect } from "next/navigation";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { users } from "./db/schema";
import { loginSchema } from "./validation";
import authConfig from "../auth.config";
import { resolveSessionUser, type SessionUser } from "./session-user";

// Rate limiting lives in middleware.ts (per real client IP) — the
// Credentials authorize() callback runs server-side without request headers,
// so the bucket key would always have collapsed to a single global counter.

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (raw) => {
        const parsed = loginSchema.safeParse({
          email: raw?.email,
          password: raw?.password,
        });
        if (!parsed.success) return null;

        const db = getDb();
        const row = await db
          .select()
          .from(users)
          .where(eq(users.email, parsed.data.email.toLowerCase()))
          .get();
        if (!row) return null;

        const ok = await argon2.verify(row.passwordHash, parsed.data.password);
        if (!ok) return null;

        return {
          id: row.id,
          email: row.email,
          name: row.displayName,
          sessionVersion: row.sessionVersion,
        };
      },
    }),
  ],
});

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2 });
}

/**
 * The signed-in user, verified against the database (deleted users, revoked
 * sessions and stale roles all resolve to null / the current role). Every
 * API route and server page must authorize through this — never through
 * `auth()`'s session object directly. Memoized per request.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const session = await auth();
  return resolveSessionUser(session?.user as { id?: string; sv?: number } | undefined);
});

/** Server pages: the current user, or a redirect to /login. */
export async function requirePageUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function getCurrentUserId(): Promise<string | null> {
  return (await getCurrentUser())?.id ?? null;
}

export async function requireUserId(): Promise<string> {
  const id = await getCurrentUserId();
  if (!id) throw new Error("not authenticated");
  return id;
}

export async function getCurrentUserRole(): Promise<string> {
  return (await getCurrentUser())?.role ?? "member";
}

export async function requireAdmin(): Promise<string> {
  const user = await getCurrentUser();
  if (!user) throw new Error("not authenticated");
  if (user.role !== "admin") throw new Error("forbidden");
  return user.id;
}
