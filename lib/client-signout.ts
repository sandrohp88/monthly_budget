"use client";

/**
 * Sign out and drop every CacheStorage entry for this origin first.
 *
 * The service worker only caches public static assets (public/sw.js), so this
 * is defence in depth: it guarantees that nothing an older worker stored,
 * such as the pre-v3 "finance-os-v2" cache of authenticated pages, outlives
 * the session on a shared device. Cache failures never block the sign-out.
 */
export async function signOutAndClearCaches(callbackUrl = "/login"): Promise<void> {
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    navigator.serviceWorker?.controller?.postMessage({ type: "clear-caches" });
  } catch {
    // Private mode / blocked storage: nothing cached to clear.
  }
  const { signOut } = await import("next-auth/react");
  await signOut({ callbackUrl });
}
