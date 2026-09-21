import { eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { users } from "./db/schema";

/** The signed-in user as the database says they are right now. */
export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "member";
};

/** Claims we put in the JWT (see auth.config.ts). */
export type SessionClaims = { id?: string; sv?: number } | null | undefined;

/**
 * Turn JWT claims into a live user, or null when the session must no longer
 * be honoured. A signed, unexpired JWT is NOT enough on its own: the user may
 * have been deleted, demoted, or changed their password since it was issued.
 *
 *   - no row for the id           → deleted user → null
 *   - token version ≠ row version → revoked (password/role change) → null
 *   - role comes from the row, never the token, so a demotion is immediate
 *
 * Tokens issued before migration 0041 carry no version and count as 0, which
 * matches every row until its first bump.
 */
export function resolveSessionUser(claims: SessionClaims): SessionUser | null {
  if (!claims?.id) return null;
  const row = getDb()
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .where(eq(users.id, claims.id))
    .get();
  if (!row) return null;
  if (row.sessionVersion !== (claims.sv ?? 0)) return null;
  return { id: row.id, email: row.email, displayName: row.displayName, role: row.role };
}
