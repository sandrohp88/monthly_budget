import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REFRESH_COALESCE_MS,
  STICKY_MS,
  notifyNavigation,
  requestRefresh,
  resetRefreshCoalescing,
} from "./refresh-after-mutation";

describe("refresh after mutation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRefreshCoalescing();
  });
  afterEach(() => {
    resetRefreshCoalescing();
    vi.useRealTimers();
  });

  it("a single mutation refreshes at once and once more after the window", () => {
    const refresh = vi.fn();
    requestRefresh(refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
    // The leading refresh may be discarded by a navigation the user starts
    // while it is pending; the trailing one runs after that chance.
    vi.advanceTimersByTime(REFRESH_COALESCE_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(REFRESH_COALESCE_MS * 10);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("a burst (save-per-keystroke) costs about 2 refreshes per second", () => {
    const refresh = vi.fn();
    for (let i = 0; i < 40; i++) {
      requestRefresh(refresh);
      vi.advanceTimersByTime(50); // 2 s of typing
    }
    vi.advanceTimersByTime(REFRESH_COALESCE_MS * 2);
    // Leading + one per 500 ms window, + the final trailing one.
    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("a navigation while a refresh is pending re-issues one after it", () => {
    const refresh = vi.fn();
    requestRefresh(refresh); // leading, t=0
    vi.advanceTimersByTime(REFRESH_COALESCE_MS); // trailing, t=500
    expect(refresh).toHaveBeenCalledTimes(2);
    // A slow render: the trailing refresh is still pending when the user
    // navigates at t=600, which discards it in Next. The navigation commits
    // and the layout effect signals it.
    vi.advanceTimersByTime(100);
    notifyNavigation(refresh);
    vi.advanceTimersByTime(REFRESH_COALESCE_MS);
    expect(refresh).toHaveBeenCalledTimes(3);
    // ...and a second navigation later in the sticky window does it again.
    vi.advanceTimersByTime(2_000);
    notifyNavigation(refresh);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("navigations without a recent mutation never refresh", () => {
    const refresh = vi.fn();
    notifyNavigation(refresh);
    expect(refresh).not.toHaveBeenCalled();
    requestRefresh(refresh);
    vi.advanceTimersByTime(STICKY_MS + REFRESH_COALESCE_MS);
    const before = refresh.mock.calls.length;
    notifyNavigation(refresh);
    vi.advanceTimersByTime(REFRESH_COALESCE_MS * 4);
    expect(refresh.mock.calls.length).toBe(before);
  });

  it("navigating over and over does not loop or extend the sticky window", () => {
    const refresh = vi.fn();
    requestRefresh(refresh);
    // A navigation every 100 ms for 30 s.
    for (let t = 0; t < 30_000; t += 100) {
      notifyNavigation(refresh);
      vi.advanceTimersByTime(100);
    }
    const calls = refresh.mock.calls.length;
    // Bounded by the sticky window: at most one per coalesce window in it.
    expect(calls).toBeLessThanOrEqual(STICKY_MS / REFRESH_COALESCE_MS + 3);
    vi.advanceTimersByTime(60_000);
    notifyNavigation(refresh);
    expect(refresh.mock.calls.length).toBe(calls);
  });
});
