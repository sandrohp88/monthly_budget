import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

// API-level coverage for web push: status, endpoint allowlist, subscribe
// (idempotent upsert), unsubscribe, and the test-send route. The endpoint is
// shaped like FCM but never delivered to: test-send runs only after the
// subscription is gone, so CI never contacts a real push service.
// Real device delivery can't run headless.

// Valid-shaped RFC 8291 keys (65-byte P-256 point, 16-byte auth); fixtures only.
const P256DH = "BPDgszmXlM_1ukvzK7bszaFGiBl-mmuRqlgDTnmMuYJfc1jbeMaNn4F4KF9ZNXNQzxOxRT8OuXhIY-jB1LZWvrY";
const AUTH = "r1PEFGSoGlerrCBGMWdAcw";

test("push status, allowlist, subscribe, unsubscribe and test-send round-trip", async ({ page }) => {
  await ensureAuth(page);

  const status = await page.request.get("/api/push");
  expect(status.ok()).toBe(true);
  const statusBody = (await status.json()) as { configured: boolean; publicKey: string | null };
  expect(statusBody.configured).toBe(true);
  expect(statusBody.publicKey).toBeTruthy();

  // Review 2026-09-21 R04: non-push-service endpoints and bad keys are refused.
  for (const bad of ["https://127.0.0.1:9443/internal", "https://push.example.invalid/e2e/sub-1"]) {
    const res = await page.request.post("/api/push", {
      data: { endpoint: bad, keys: { p256dh: P256DH, auth: AUTH } },
    });
    expect(res.status(), bad).toBe(400);
  }
  const badKeys = await page.request.post("/api/push", {
    data: { endpoint: "https://fcm.googleapis.com/fcm/send/e2e", keys: { p256dh: "x", auth: "y" } },
  });
  expect(badKeys.status()).toBe(400);

  const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${Date.now()}`;
  const subscribe = await page.request.post("/api/push", {
    data: { endpoint, keys: { p256dh: P256DH, auth: AUTH }, userAgent: "e2e" },
  });
  expect(subscribe.status()).toBe(201);

  // Same endpoint again: upsert, not a unique-constraint 500.
  const resubscribe = await page.request.post("/api/push", {
    data: { endpoint, keys: { p256dh: P256DH, auth: AUTH } },
  });
  expect(resubscribe.status()).toBe(201);

  const after = (await (await page.request.get("/api/push")).json()) as { endpoints: string[] };
  expect(after.endpoints).toContain(endpoint);

  const unsubscribe = await page.request.delete("/api/push", { data: { endpoint } });
  expect(unsubscribe.ok()).toBe(true);
  const final = (await (await page.request.get("/api/push")).json()) as { endpoints: string[] };
  expect(final.endpoints).not.toContain(endpoint);

  // With no devices left the route still round-trips and sends nothing.
  const testSend = await page.request.post("/api/push/test");
  expect(testSend.ok()).toBe(true);
  expect(((await testSend.json()) as { sent: number }).sent).toBe(0);
});

test("settings page renders the notifications card", async ({ page }) => {
  await ensureAuth(page);
  await page.goto("/settings");
  await expect(page.getByText("Notifications", { exact: true })).toBeVisible();
  await expect(page.getByText(/no planned payment/i).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /enable on this device/i })).toBeVisible();
});
