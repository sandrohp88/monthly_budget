import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const NOTE = "EARLYSHIFT-PAY";

/**
 * Deleting a paycheck writes through fetch(), which does not invalidate
 * Next's client route cache. A sidebar link refetches a dynamic page, but
 * Back restores the dashboard entry cached before the delete — so the
 * projection still expects the paycheck until router.refresh() runs.
 */
test("deleting a paycheck occurrence drops it from the cached projection", async ({ page }) => {
  await ensureAuth(page);

  const today = new Date().toISOString().slice(0, 10);
  const payDate = addDaysIso(today, 2);
  const created = await page.request.post("/api/paychecks", {
    data: { payDate, amountCents: 200_000, note: NOTE },
  });
  expect(created.ok()).toBeTruthy();
  const { paycheck } = (await created.json()) as { paycheck: { id: string } };

  try {
    // Full load seeds the client route cache with a projection that still
    // expects this occurrence. A later client-side return must not reuse it.
    await page.goto("/");
    await expect(page.getByText(NOTE).first()).toBeVisible();

    await page.getByRole("link", { name: /^paychecks/i }).first().click();
    await page.waitForURL("**/paychecks");

    const refreshed = page.waitForResponse(
      (res) =>
        res.request().method() === "GET" &&
        res.ok() &&
        res.request().headers()["rsc"] === "1" &&
        new URL(res.url()).pathname === "/paychecks",
    );
    await page.getByRole("button", { name: `Delete paycheck ${payDate} (${NOTE})` }).click();
    await expect(page.getByText(/paycheck removed/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Delete paycheck ${payDate} (${NOTE})` }),
    ).toHaveCount(0);
    await refreshed;

    // Back returns to the dashboard entry that was cached before the delete.
    // A link click refetches dynamic pages; the back stack is what keeps the
    // old projection on screen until refresh clears it.
    await page.goBack();
    await page.waitForURL((url) => new URL(url).pathname === "/");
    await expect(page.getByText(NOTE)).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/paychecks/${paycheck.id}`);
  }
});
