import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { users } from "./db/schema";
import { loginSchema } from "./validation";
import authConfig from "../auth.config";

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

        return { id: row.id, email: row.email, name: row.displayName, role: row.role };
      },
    }),
  ],
});

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2 });
}

export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth();
  const id = (session?.user as { id?: string } | undefined)?.id;
  return id ?? null;
}

export async function requireUserId(): Promise<string> {
  const id = await getCurrentUserId();
  if (!id) throw new Error("not authenticated");
  return id;
}

export async function getCurrentUserRole(): Promise<string> {
  const session = await auth();
  return (session?.user as { role?: string } | undefined)?.role ?? "member";
}

export async function requireAdmin(): Promise<string> {
  const [id, role] = await Promise.all([getCurrentUserId(), getCurrentUserRole()]);
  if (!id) throw new Error("not authenticated");
  if (role !== "admin") throw new Error("forbidden");
  return id;
}
