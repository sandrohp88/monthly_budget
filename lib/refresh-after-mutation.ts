"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * The one rule for client writes (CLAUDE.md §17): after a mutation that
 * changes server-rendered data succeeds, call the function this hook returns.
 * Name it `refreshAfterMutation`: the contract test counts those calls.
 *
 * Why not a bare `router.refresh()`: a plain `fetch` leaves Next's client
 * router cache holding pre-mutation payloads (Back restores them), and the
 * shared (app) layout (sidebar net position and 30-day delta) is not
 * re-rendered on client navigation. `router.refresh()` fixes both, but only
 * once its server response is APPLIED. In Next 15 a refresh is an async router
 * action; a NAVIGATE or RESTORE (Back) dispatched while it is pending marks it
 * `discarded`, and its result, including the cache reset, is dropped
 * (next/dist/client/components/app-router-instance.js, dispatchAction). So
 * "refresh, then the user clicks a link 100 ms later" silently loses it.
 *
 * What this helper does:
 * 1. A leading refresh at once, and always ONE trailing refresh
 *    REFRESH_COALESCE_MS later. Calls in between are absorbed by the trailing
 *    one, so save-per-keystroke editors cost about 2 refreshes per second.
 * 2. Sticky for STICKY_MS after the last mutation: every client navigation
 *    (pathname or query change, Back/Forward included) in that time requests
 *    another coalesced refresh. `<RefreshOnNavigation />` in the (app) layout
 *    sends that signal from an effect, i.e. after the navigation committed,
 *    so that navigation cannot discard it; it re-renders the current page and
 *    the layout. A navigation never extends the sticky window, so navigating
 *    over and over cannot loop.
 *
 * Remaining gap: if every refresh in the STICKY_MS window is discarded (the
 * user keeps navigating faster than the server renders for 10 s) and the last
 * one is discarded by a navigation after the window, data stays stale until
 * the next mutation or reload. Next 15 gives no "refresh applied" signal that
 * would close this exactly.
 */
export function useRefreshAfterMutation(): () => void {
  const router = useRouter();
  return React.useCallback(() => requestRefresh(() => router.refresh()), [router]);
}

/** Mounted once in the (app) layout: re-arms a refresh after navigations. */
export function RefreshOnNavigation(): null {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? "";
  React.useEffect(() => {
    notifyNavigation(() => router.refresh());
  }, [pathname, search, router]);
  return null;
}

export const REFRESH_COALESCE_MS = 500;
export const STICKY_MS = 10_000;

let lastRefreshAt = Number.NEGATIVE_INFINITY;
let trailing: ReturnType<typeof setTimeout> | null = null;
let stickyUntil = Number.NEGATIVE_INFINITY;

function schedule(refresh: () => void, now: number): void {
  if (trailing) return; // the queued trailing refresh covers this request
  const fire = () => {
    trailing = null;
    lastRefreshAt = Date.now();
    refresh();
  };
  const wait = lastRefreshAt + REFRESH_COALESCE_MS - now;
  if (wait <= 0) {
    lastRefreshAt = now;
    refresh();
    trailing = setTimeout(fire, REFRESH_COALESCE_MS);
    return;
  }
  trailing = setTimeout(fire, wait);
}

/** A mutation succeeded. Exported for tests; components use the hook. */
export function requestRefresh(refresh: () => void, now: number = Date.now()): void {
  stickyUntil = now + STICKY_MS;
  schedule(refresh, now);
}

/** A client navigation committed. Exported for tests. */
export function notifyNavigation(refresh: () => void, now: number = Date.now()): void {
  if (now <= stickyUntil) schedule(refresh, now);
}

/** Test-only: forget all state between tests. */
export function resetRefreshCoalescing(): void {
  if (trailing) clearTimeout(trailing);
  trailing = null;
  lastRefreshAt = Number.NEGATIVE_INFINITY;
  stickyUntil = Number.NEGATIVE_INFINITY;
}
