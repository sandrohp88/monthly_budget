import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFRESH_COALESCE_MS, requestRefresh, resetRefreshCoalescing } from "./refresh-after-mutation";

describe("requestRefresh coalescing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRefreshCoalescing();
  });
  afterEach(() => {
    resetRefreshCoalescing();
    vi.useRealTimers();
  });

  it("refreshes at once for a single mutation", () => {
    const refresh = vi.fn();
    requestRefresh(refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a burst (save-per-keystroke) gives one leading and one trailing refresh", () => {
    const refresh = vi.fn();
    requestRefresh(refresh);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(50);
      requestRefresh(refresh);
    }
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REFRESH_COALESCE_MS);
    // The trailing refresh runs after the last write, so no write is left out.
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("refreshes at once again after the window has passed", () => {
    const refresh = vi.fn();
    requestRefresh(refresh);
    vi.advanceTimersByTime(REFRESH_COALESCE_MS + 1);
    requestRefresh(refresh);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
