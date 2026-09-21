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
    // The token only records WHO signed in and at which session version.
    // It is never trusted for authorization on its own: the edge middleware
    // can't reach the DB, so every server-side check goes through
    // resolveSessionUser (lib/session-user.ts), which rejects deleted users
    // and stale versions and reads the role from the database.
    jwt: ({ token, user }) => {
      if (user) {
        token.uid = (user as { id: string }).id;
        token.sv = (user as { sessionVersion?: number }).sessionVersion ?? 0;
        delete token.role;
      }
      return token;
    },
    session: ({ session, token }) => {
      if (session.user && token.uid) {
        const u = session.user as { id?: string; sv?: number };
        u.id = token.uid as string;
        u.sv = typeof token.sv === "number" ? token.sv : 0;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;

export default authConfig;
