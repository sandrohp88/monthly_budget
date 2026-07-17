/**
 * Next.js instrumentation hook — runs once when a server instance boots.
 * The NEXT_RUNTIME check must stay in this exact `if` form: Next inlines the
 * value per compilation, so the edge build dead-code-eliminates the dynamic
 * import (web-push and the DB client can't compile for edge).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPushScheduler } = await import("./lib/push-scheduler");
    startPushScheduler();
  }
}
