import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

// API-level coverage for web push: status, subscribe (idempotent upsert),
// test-send fan-out, and unsubscribe. The endpoint is fake, so the test-send
// reports the subscription as failed/pruned rather than sent — what matters
// is that the route round-trips and never 500s. Real device delivery can't
// run headless (it needs a push-service connection).
test("push status, subscribe, test-send, and unsubscribe round-trip", async ({ page }) => {
  await ensureAuth(page);

  const status = await page.request.get("/api/push");
  expect(status.ok()).toBe(true);
  const statusBody = (await status.json()) as { configured: boolean; publicKey: string | null };
  expect(statusBody.configured).toBe(true);
  expect(statusBody.publicKey).toBeTruthy();

  const endpoint = "https://push.example.invalid/e2e/sub-1";
  const subscribe = await page.request.post("/api/push", {
    data: { endpoint, keys: { p256dh: "e2e-p256dh", auth: "e2e-auth" }, userAgent: "e2e" },
  });
  expect(subscribe.status()).toBe(201);

  // Same endpoint again: upsert, not a unique-constraint 500.
  const resubscribe = await page.request.post("/api/push", {
    data: { endpoint, keys: { p256dh: "e2e-p256dh-2", auth: "e2e-auth-2" } },
  });
  expect(resubscribe.status()).toBe(201);

  const after = (await (await page.request.get("/api/push")).json()) as {
    subscriptionCount: number;
    endpoints: string[];
  };
  expect(after.endpoints).toContain(endpoint);

  // Test-send exercises the real dispatch path; the fake endpoint can't be
  // delivered to, so it must come back failed or pruned — never a 500.
  const testSend = await page.request.post("/api/push/test");
  expect(testSend.ok()).toBe(true);
  const testBody = (await testSend.json()) as { sent: number; pruned: number; failed: number };
  expect(testBody.sent).toBe(0);
  expect(testBody.pruned + testBody.failed).toBeGreaterThanOrEqual(1);

  const unsubscribe = await page.request.delete("/api/push", { data: { endpoint } });
  expect(unsubscribe.ok()).toBe(true);
  const final = (await (await page.request.get("/api/push")).json()) as { endpoints: string[] };
  expect(final.endpoints).not.toContain(endpoint);
});

test("settings page renders the notifications card", async ({ page }) => {
  await ensureAuth(page);
  await page.goto("/settings");
  await expect(page.getByText("Notifications", { exact: true })).toBeVisible();
  await expect(page.getByText(/no planned payment/i).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /enable on this device/i })).toBeVisible();
});
