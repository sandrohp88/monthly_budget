/**
 * Next.js instrumentation hook — runs once when a server instance boots.
 * The NEXT_RUNTIME check must stay in this exact `if` form: Next inlines the
 * value per compilation, so the edge build dead-code-eliminates the dynamic
 * import (web-push and the DB client can't compile for edge).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Migrate before anything else touches the DB: API routes (Plaid webhook)
    // and the push timer can run before any page renders. A failure throws
    // from register() so boot fails loudly instead of limping on a stale schema.
    const { runMigrations } = await import("./lib/db/client");
    try {
      runMigrations();
    } catch (err) {
      // Next does not print errors thrown from register(); log, then rethrow.
      console.error("[boot] database migration failed, refusing to start:", err);
      throw err;
    }
    const { startPushScheduler } = await import("./lib/push-scheduler");
    startPushScheduler();
  }
}
