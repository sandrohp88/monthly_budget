import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Sign-out on a shared device must not leave this browser subscribed to the
// previous user's card alerts (review 2026-11-10 AUTH-5): the server row is
// deleted first (it needs the session cookie), then the browser subscription,
// then the session ends. Every push step is best-effort.

const calls: string[] = [];

vi.mock("next-auth/react", () => ({
  signOut: vi.fn(async () => {
    calls.push("signOut");
  }),
}));

import { signOutAndClearCaches } from "./client-signout";
import { PUSH_SIGNOUT_TIMEOUT_MS } from "./client-push";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-1";

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

function fakeSubscription() {
  return {
    endpoint: ENDPOINT,
    unsubscribe: vi.fn(async () => {
      calls.push("unsubscribe");
      return true;
    }),
  };
}

function installBrowser(opts: {
  serviceWorker?: boolean;
  pushManager?: boolean;
  subscription?: ReturnType<typeof fakeSubscription> | null;
  fetch?: FetchImpl;
}) {
  const subscription = opts.subscription ?? null;
  const registration = {
    pushManager: { getSubscription: vi.fn(async () => subscription) },
  };
  const nav: Record<string, unknown> = {};
  if (opts.serviceWorker !== false) {
    nav.serviceWorker = {
      controller: { postMessage: vi.fn() },
      getRegistration: vi.fn(async () => registration),
    };
  }
  const win: Record<string, unknown> = {};
  if (opts.pushManager !== false) win.PushManager = function PushManager() {};
  const fetchMock = vi.fn(
    opts.fetch ??
      (async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url} ${String(init?.body)}`);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
  );
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", nav);
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, registration };
}

describe("signOutAndClearCaches removes this device's push subscription", () => {
  beforeEach(() => {
    calls.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("deletes the server row for the endpoint, then unsubscribes, then signs out", async () => {
    const sub = fakeSubscription();
    const { fetchMock } = installBrowser({ subscription: sub });

    await signOutAndClearCaches();

    expect(calls).toEqual([
      `DELETE /api/push ${JSON.stringify({ endpoint: ENDPOINT })}`,
      "unsubscribe",
      "signOut",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("still unsubscribes and signs out when the DELETE fails", async () => {
    const sub = fakeSubscription();
    installBrowser({
      subscription: sub,
      fetch: async () => {
        calls.push("DELETE failed");
        throw new TypeError("Failed to fetch");
      },
    });

    await signOutAndClearCaches();

    expect(calls).toEqual(["DELETE failed", "unsubscribe", "signOut"]);
  });

  it("still unsubscribes and signs out when the DELETE is refused (revoked session)", async () => {
    const sub = fakeSubscription();
    installBrowser({
      subscription: sub,
      fetch: async () => {
        calls.push("DELETE 401");
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      },
    });

    await signOutAndClearCaches();

    expect(calls).toEqual(["DELETE 401", "unsubscribe", "signOut"]);
  });

  it("aborts a DELETE that hangs and still unsubscribes and signs out", async () => {
    vi.useFakeTimers();
    const sub = fakeSubscription();
    installBrowser({
      subscription: sub,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          calls.push("DELETE sent");
          init?.signal?.addEventListener("abort", () => {
            calls.push("DELETE aborted");
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });

    const done = signOutAndClearCaches();
    await vi.advanceTimersByTimeAsync(PUSH_SIGNOUT_TIMEOUT_MS + 10);
    await done;

    expect(calls).toEqual(["DELETE sent", "DELETE aborted", "unsubscribe", "signOut"]);
  });

  it("still signs out when unsubscribe throws", async () => {
    const sub = fakeSubscription();
    sub.unsubscribe.mockImplementation(async () => {
      calls.push("unsubscribe threw");
      throw new Error("push service unreachable");
    });
    installBrowser({ subscription: sub });

    await signOutAndClearCaches();

    expect(calls.slice(1)).toEqual(["unsubscribe threw", "signOut"]);
  });

  it("sends no DELETE when this device has no subscription", async () => {
    const { fetchMock } = installBrowser({ subscription: null });

    await signOutAndClearCaches();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls).toEqual(["signOut"]);
  });

  it("goes straight to sign-out without service worker support", async () => {
    const { fetchMock } = installBrowser({ serviceWorker: false });

    await signOutAndClearCaches();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls).toEqual(["signOut"]);
  });

  it("goes straight to sign-out without PushManager support", async () => {
    const { fetchMock, registration } = installBrowser({ pushManager: false });

    await signOutAndClearCaches();

    expect(registration.pushManager.getSubscription).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls).toEqual(["signOut"]);
  });

  it("still signs out when reading the registration throws", async () => {
    const { fetchMock } = installBrowser({ subscription: fakeSubscription() });
    (navigator as unknown as { serviceWorker: { getRegistration: () => Promise<never> } })
      .serviceWorker.getRegistration = async () => {
      throw new Error("SecurityError");
    };

    await signOutAndClearCaches();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls).toEqual(["signOut"]);
  });
});
