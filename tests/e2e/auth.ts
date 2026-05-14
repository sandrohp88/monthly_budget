import { type Page, expect } from "@playwright/test";

const TEST_EMAIL = "test@example.com";
const TEST_PASSWORD = "supersecret1";

/**
 * Ensures the user is authenticated. If no user exists, creates one via
 * /setup. If a user exists, logs in via /login.
 *
 * After this returns, the page is on "/" (dashboard) and authenticated.
 */
export async function ensureAuth(page: Page) {
  await page.goto("/");
  await page.waitForURL(/\/(setup|login|$)/);

  const url = page.url();

  if (url.includes("/setup")) {
    await page.getByLabel(/display name/i).fill("Tester");
    await page.getByLabel(/^email$/i).fill(TEST_EMAIL);
    await page.getByLabel(/password \(min 8 chars\)/i).fill(TEST_PASSWORD);
    await page.getByLabel(/^starting balance$/i).fill("1000");
    await page.getByLabel(/default paycheck/i).fill("2000");
    await page.getByRole("button", { name: /create account/i }).click();
  } else if (url.includes("/login")) {
    await page.getByLabel(/^email$/i).fill(TEST_EMAIL);
    await page.getByLabel(/password/i).fill(TEST_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
  }

  await page.waitForURL("/");
  await expect(page.locator("[data-app-shell]")).toBeVisible();
}
