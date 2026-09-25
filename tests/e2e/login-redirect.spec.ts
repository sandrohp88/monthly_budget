import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

// Review 2026-09-24 C03: /login?next= must never send a freshly signed-in
// user to another site. One credential POST only — logins are rate-limited
// per IP (see tests/e2e/auth.ts).
test("login ignores an off-site ?next= and lands on the dashboard", async ({ page, browser }) => {
  await ensureAuth(page); // makes sure the test user exists

  const context = await browser.newContext();
  const fresh = await context.newPage();
  await fresh.goto("/login?next=https://example.com/phish");
  await fresh.getByLabel(/^email$/i).fill("test@example.com");
  await fresh.getByLabel(/password/i).fill("supersecret1");
  await fresh.getByRole("button", { name: /sign in/i }).click();

  await fresh.waitForURL((url) => url.pathname === "/" || url.hostname === "example.com");
  const landed = new URL(fresh.url());
  expect(landed.hostname).toBe("localhost");
  expect(landed.pathname).toBe("/");
  await expect(fresh.locator("[data-app-shell]")).toBeVisible();
  await context.close();
});
