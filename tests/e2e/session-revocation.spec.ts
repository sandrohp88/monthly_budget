import { test, expect, type Browser } from "@playwright/test";
import { ensureAuth } from "./auth";

// Review 2026-09-21 R05: an old session must not outlive a demotion,
// password change, or deletion of its user.

async function signInAs(browser: Browser, email: string, password: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel(/^email$/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("/");
  return { context, page };
}

test("session revocation: demotion, password change and deletion end old sessions", async ({
  page,
  browser,
}) => {
  await ensureAuth(page);

  const email = `revoke-${Date.now()}@example.com`;
  const password = "second-admin-pw";
  const created = await page.request.post("/api/users", {
    data: { email, displayName: "Second Admin", password, role: "admin" },
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();

  // Demotion: the old admin cookie loses admin access immediately.
  const first = await signInAs(browser, email, password);
  expect((await first.page.request.get("/api/users")).status()).toBe(200);
  const demote = await page.request.patch(`/api/users/${id}`, { data: { role: "member" } });
  expect(demote.ok()).toBe(true);
  expect((await first.page.request.get("/api/users")).status()).toBe(401);
  await first.page.goto("/settings");
  await expect(first.page).toHaveURL(/\/login/);
  await first.context.close();

  // Password reset by an admin: the user's existing session ends.
  const second = await signInAs(browser, email, password);
  expect((await second.page.request.get("/api/settings")).ok()).toBe(true);
  const reset = await page.request.patch(`/api/users/${id}`, {
    data: { currentPassword: "__admin_reset__", newPassword: "reset-password-2" },
  });
  expect(reset.ok()).toBe(true);
  expect((await second.page.request.get("/api/settings")).status()).toBe(401);
  await second.context.close();

  // Deletion: the deleted user's cookie is worthless.
  const third = await signInAs(browser, email, "reset-password-2");
  expect((await third.page.request.get("/api/settings")).ok()).toBe(true);
  const del = await page.request.delete(`/api/users/${id}`);
  expect(del.ok()).toBe(true);
  expect((await third.page.request.get("/api/settings")).status()).toBe(401);
  await third.context.close();

  // The acting admin's own session is untouched throughout.
  expect((await page.request.get("/api/users")).status()).toBe(200);
});
