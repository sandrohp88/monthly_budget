import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

// Review 2026-09-21 R09: the service worker cached authenticated pages, so a
// financial page was still readable offline after logout. Only public static
// assets may be cached, and the legacy cache must be purged on upgrade.

test("service worker never serves private pages offline and purges the legacy cache", async ({
  page,
  browser,
}) => {
  await ensureAuth(page);
  const billName = `Offline Privacy Bill ${Date.now()}`;
  const billRes = await page.request.post("/api/bills", {
    data: {
      name: billName,
      category: "Other",
      amountCents: 1234,
      intervalMonths: 1,
      anchorDate: "2026-09-01",
    },
  });
  expect(billRes.ok()).toBe(true);
  const cookies = await page.context().cookies();

  // Fresh context: seed a pre-v3 cache holding a "private page" BEFORE the
  // new worker is installed. /offline.html doesn't register the worker.
  const context = await browser.newContext();
  const p = await context.newPage();
  await p.goto("/offline.html");
  await p.evaluate(async () => {
    const legacy = await caches.open("finance-os-v2");
    await legacy.put("/bills", new Response("LEGACY PRIVATE PAGE", { headers: { "content-type": "text/html" } }));
  });

  await context.addCookies(cookies);
  await p.goto("/bills");
  await expect(p.getByText(billName)).toBeVisible();
  await p.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, {
    timeout: 15_000,
  });

  // Upgrade purged the legacy cache.
  await expect
    .poll(() => p.evaluate(async () => (await caches.keys()).sort()))
    .toEqual(["finance-os-static-v3"]);

  // Browse a bit more; no page HTML may land in any cache.
  await p.reload();
  await expect(p.getByText(billName)).toBeVisible();
  const cachedPaths = await p.evaluate(async () => {
    const out: string[] = [];
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      for (const req of await cache.keys()) out.push(new URL(req.url).pathname);
    }
    return out;
  });
  expect(cachedPaths).toContain("/offline.html");
  for (const path of cachedPaths) {
    expect(
      path === "/offline.html" ||
        path === "/manifest.json" ||
        path.startsWith("/_next/static/") ||
        path.startsWith("/icons/"),
      `unexpected cached path ${path}`,
    ).toBe(true);
  }

  // Logged out and offline: the offline screen, not the financial page.
  await context.clearCookies();
  await context.setOffline(true);
  await p.reload();
  await expect(p.getByRole("heading", { name: /you're offline/i })).toBeVisible();
  await expect(p.getByText(billName)).toHaveCount(0);
  await context.setOffline(false);
  await context.close();
});

test("offline page is public", async ({ request }) => {
  const res = await request.get("/offline.html", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain("You're offline");
});
