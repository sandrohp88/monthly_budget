import fs from "node:fs";
import path from "node:path";
import { type Page, expect } from "@playwright/test";

const TEST_EMAIL = "test@example.com";
const TEST_PASSWORD = "supersecret1";

type Cookies = Parameters<ReturnType<Page["context"]>["addCookies"]>[0];

// One credential POST per run: the app rate-limits logins per IP (leaky
// bucket: a burst of 5, then 5 per 15 minutes — see LOGIN_RATE_LIMIT in
// lib/rate-limit.ts), so a fresh login per spec gets the tail of the suite
// rate-limited. The whole suite uses exactly 5 credential POSTs: /setup's
// sign-in here, 1 in login-redirect and 3 in session-revocation.
//
// Playwright discards the worker (and this module's memory) after any test
// failure, so the session is also kept in a storageState file. A retry or a
// new worker reuses it and never needs a 6th POST. global-setup deletes the
// file at the start of each run, because it wipes the test DB.
export const AUTH_STATE_FILE = path.resolve("data", "e2e-auth-state.json");
let savedCookies: Cookies | null = null;

function loadSavedCookies(): Cookies | null {
  if (savedCookies) return savedCookies;
  try {
    const state = JSON.parse(fs.readFileSync(AUTH_STATE_FILE, "utf8")) as { cookies: Cookies };
    savedCookies = state.cookies;
  } catch {
    return null; // no session saved yet in this run
  }
  return savedCookies;
}

/**
 * Ensures the user is authenticated. If no user exists, creates one via
 * /setup. If a user exists, logs in via /login — once per run; later calls
 * (also in a new worker) reuse the session cookie.
 *
 * After this returns, the page is on "/" (dashboard) and authenticated.
 */
export async function ensureAuth(page: Page) {
  const cookies = loadSavedCookies();
  if (cookies) {
    await page.context().addCookies(cookies);
    await page.goto("/");
    if (!/\/(setup|login)/.test(page.url())) {
      await expect(page.locator("[data-app-shell]")).toBeVisible();
      return;
    }
  }

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
  savedCookies = await page.context().cookies();
  await page.context().storageState({ path: AUTH_STATE_FILE });
}
