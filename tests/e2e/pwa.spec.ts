import { test, expect } from "@playwright/test";

// PWA assets must be reachable WITHOUT a session. Browsers fetch the manifest
// with credentials omitted (no cookie even when logged in) and iOS fetches
// touch icons anonymously, so an auth redirect here breaks installability —
// which is exactly how the PR #40 scaffold shipped broken. The `request`
// fixture carries no cookies; maxRedirects: 0 makes a 307-to-/login fail the
// status assertion instead of following it.

test("manifest.json is public and lists installable icons", async ({ request }) => {
  const res = await request.get("/manifest.json", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  const manifest = await res.json();
  expect(manifest.display).toBe("standalone");
  expect(
    manifest.icons.filter(
      (i: { purpose: string; type: string }) =>
        i.purpose === "maskable" && i.type === "image/png",
    ).length,
  ).toBeGreaterThan(0);
});

test("service worker and icons are public", async ({ request }) => {
  const paths = [
    "/sw.js",
    "/icons/apple-touch-icon.png",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/icons/icon-maskable-192.png",
    "/icons/icon-maskable-512.png",
    "/icons/bluefalls-mark.svg",
  ];
  for (const path of paths) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(200);
  }
});
