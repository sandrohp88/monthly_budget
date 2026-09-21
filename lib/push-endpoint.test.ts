import { describe, expect, it, vi, beforeEach } from "vitest";
import { isAllowedPushEndpoint, isValidPushKeys } from "./push-endpoint";

// Review 2026-09-21 R04: push endpoints were an authenticated
// outbound-request primitive. No traffic is sent by these tests.

const P256DH = "BPDgszmXlM_1ukvzK7bszaFGiBl-mmuRqlgDTnmMuYJfc1jbeMaNn4F4KF9ZNXNQzxOxRT8OuXhIY-jB1LZWvrY";
const AUTH = "r1PEFGSoGlerrCBGMWdAcw";

describe("isAllowedPushEndpoint", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc:def",
    "https://android.googleapis.com/gcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
    "https://web.push.apple.com/QGuQyavXutnMA",
    "https://wns2-bl2p.notify.windows.com/w/?token=abc",
    "https://FCM.GoogleAPIs.com/fcm/send/x",
    "https://fcm.googleapis.com:443/fcm/send/x",
  ])("allows %s", (url) => {
    expect(isAllowedPushEndpoint(url)).toBe(true);
  });

  it.each([
    ["loopback IP (the review's probe)", "https://127.0.0.1:9443/internal"],
    ["private IP", "https://10.10.88.25/api"],
    ["IPv6 literal", "https://[::1]/x"],
    ["plain http", "http://fcm.googleapis.com/fcm/send/x"],
    ["non-443 port", "https://fcm.googleapis.com:8443/fcm/send/x"],
    ["userinfo", "https://user:pw@fcm.googleapis.com/fcm/send/x"],
    ["suffix confusion", "https://fcm.googleapis.com.evil.example/x"],
    ["prefix confusion", "https://evilfcm.googleapis.com/x"],
    ["unbounded suffix", "https://evilnotify.windows.com/x"],
    ["bare suffix", "https://notify.windows.com/x"],
    ["trailing dot", "https://fcm.googleapis.com./x"],
    ["unknown host", "https://push.example.invalid/e2e"],
    ["internal name", "https://budget-app:3000/api/users"],
    ["not a URL", "not a url"],
  ])("rejects %s", (_why, url) => {
    expect(isAllowedPushEndpoint(url)).toBe(false);
  });
});

describe("isValidPushKeys", () => {
  it("accepts a P-256 point and 16-byte auth", () => {
    expect(isValidPushKeys({ p256dh: P256DH, auth: AUTH })).toBe(true);
  });
  it.each([
    [{ p256dh: "e2e-p256dh", auth: AUTH }],
    [{ p256dh: P256DH, auth: "e2e-auth" }],
    [{ p256dh: "A" + P256DH.slice(1), auth: AUTH }],
    [{ p256dh: P256DH + "AAAA", auth: AUTH }],
    [{ p256dh: P256DH, auth: AUTH + "!" }],
  ])("rejects %j", (keys) => {
    expect(isValidPushKeys(keys)).toBe(false);
  });
});

// Send-time enforcement: rows stored before the allowlist must not be sent to.
const sendNotification = vi.fn();
const deleteById = vi.fn();
vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: (...a: unknown[]) => sendNotification(...a) },
}));
vi.mock("./repos", () => ({
  deletePushSubscriptionById: (id: string) => deleteById(id),
  getSettings: vi.fn(),
  listAllPushSubscriptions: vi.fn(),
  listPushSubscriptions: vi.fn(),
  markPushSubscriptionNotified: vi.fn(),
}));
vi.mock("./projection-server", () => ({ buildProjection: vi.fn() }));

describe("sendToSubscription", () => {
  beforeEach(() => {
    sendNotification.mockReset().mockResolvedValue({ statusCode: 201 });
    deleteById.mockReset().mockResolvedValue(undefined);
    process.env.VAPID_PUBLIC_KEY = "pub";
    process.env.VAPID_PRIVATE_KEY = "priv";
    process.env.VAPID_SUBJECT = "mailto:test@example.com";
  });
  const payload = { title: "t", body: "b", url: "/", tag: "x" };
  const row = (endpoint: string) =>
    ({ id: "sub-1", userId: "u", endpoint, p256dh: P256DH, auth: AUTH }) as never;

  it("prunes a stored disallowed endpoint without sending", async () => {
    const { sendToSubscription } = await import("./push");
    expect(await sendToSubscription(row("https://127.0.0.1:9443/internal"), payload)).toBe("pruned");
    expect(sendNotification).not.toHaveBeenCalled();
    expect(deleteById).toHaveBeenCalledWith("sub-1");
  });

  it("sends to an allowed endpoint with a bounded timeout", async () => {
    const { sendToSubscription } = await import("./push");
    expect(await sendToSubscription(row("https://fcm.googleapis.com/fcm/send/x"), payload)).toBe("sent");
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0]![2]).toMatchObject({ timeout: 10_000 });
  });
});
