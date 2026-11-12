"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

/**
 * The one rule for client writes (CLAUDE.md §17): after a mutation that
 * changes server-rendered data succeeds, refresh the router.
 *
 * A plain `fetch` to an API route leaves Next's client router cache holding
 * the pre-mutation payloads of pages the user already visited (Back restores
 * them), and the shared (app) layout — the sidebar net position and 30-day
 * delta — is not re-rendered on client navigation at all. `router.refresh()`
 * clears that cache and re-renders the server components while keeping client
 * state (local lists, open dialogs, focus, scroll), so the component's own
 * optimistic update stays and only server-rendered numbers change.
 *
 * Some editors save on every keystroke (paycheck amount/note), so calls are
 * coalesced: the first refresh runs at once, and calls inside the next
 * REFRESH_COALESCE_MS share one trailing refresh. The trailing refresh still
 * runs after the component unmounts — the router is app-wide, so it refreshes
 * whatever page the user is on by then.
 *
 * lib/refresh-after-mutation.contract.test.ts fails for a client file that
 * mutates without refreshing.
 */
export function useRefreshAfterMutation(): () => void {
  const router = useRouter();
  return React.useCallback(() => requestRefresh(() => router.refresh()), [router]);
}

export const REFRESH_COALESCE_MS = 500;

let lastRefreshAt = Number.NEGATIVE_INFINITY;
let trailing: ReturnType<typeof setTimeout> | null = null;

/** Leading + trailing coalescing of refreshes. Exported for tests. */
export function requestRefresh(refresh: () => void, now: number = Date.now()): void {
  if (trailing) return; // a trailing refresh is already queued and will see this write
  const wait = lastRefreshAt + REFRESH_COALESCE_MS - now;
  if (wait <= 0) {
    lastRefreshAt = now;
    refresh();
    return;
  }
  trailing = setTimeout(() => {
    trailing = null;
    lastRefreshAt = Date.now();
    refresh();
  }, wait);
}

/** Test-only: forget coalescing state between tests. */
export function resetRefreshCoalescing(): void {
  if (trailing) clearTimeout(trailing);
  trailing = null;
  lastRefreshAt = Number.NEGATIVE_INFINITY;
}
