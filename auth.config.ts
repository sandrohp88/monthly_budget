import type { NextAuthConfig } from "next-auth";

/**
 * Edge-compatible NextAuth config: no DB, no argon2, no Node modules.
 * Used by the middleware. The full config in lib/auth.ts extends this
 * with the Credentials provider for the auth route handlers.
 */
const authConfig = {
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 30 },
  pages: { signIn: "/login" },
  trustHost: true,
  providers: [],
  callbacks: {
    jwt: ({ token, user }) => {
      if (user) {
        token.uid = (user as { id: string }).id;
        token.role = (user as { role?: string }).role ?? "member";
      }
      return token;
    },
    session: ({ session, token }) => {
      if (session.user && token.uid) {
        (session.user as { id?: string; role?: string }).id = token.uid as string;
        (session.user as { id?: string; role?: string }).role = (token.role as string) ?? "member";
      }
      return session;
    },
  },
} satisfies NextAuthConfig;

export default authConfig;
