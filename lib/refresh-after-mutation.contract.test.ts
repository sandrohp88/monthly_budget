import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Review 2026-11-10 DATA-2/DATA-3. A client `fetch` that writes data does not
// invalidate Next's client router cache, and the shared (app) layout (sidebar
// net position, 30-day delta) is not re-rendered on client navigation. So
// every client file that mutates server data must refresh the router after
// success, via `useRefreshAfterMutation` (lib/refresh-after-mutation.ts),
// `router.refresh()`, or a full `window.location.reload()`. See CLAUDE.md §17
// "Client cache invalidation after mutations".
//
// The check is per file on purpose: simple, and robust to how handlers are
// written. A file that only mutates through a parent's callback, or whose
// writes change no server-rendered data, goes on the allowlist WITH a reason.

const ALLOWLIST: Record<string, string> = {
  "app/(app)/credit-cards/card-dialogs.tsx":
    "dialogs only; every onSaved caller refreshes (credit-cards-client reloads, card-detail-client calls router.refresh)",
  "components/promo-reconcile-dialog.tsx":
    "dialog only; its one caller (card-detail-client onApplied) calls router.refresh",
  "app/(app)/paychecks/schedule-dialog.tsx":
    "dialog only; its one caller (paychecks-client onApplied) calls router.refresh",
  "components/plaid-link-button.tsx":
    "link-token POST writes nothing rendered; the exchange result goes to onLinked, and accounts-client refreshes there",
  "components/push-notifications-card.tsx":
    "push subscribe/unsubscribe/test; push state is read client-side from /api/push, no server render uses it",
};

const MUTATING_METHOD = /["'`](POST|PUT|PATCH|DELETE)["'`]/;
const REFRESHES = /\buseRefreshAfterMutation\s*\(|\brouter\.refresh\s*\(|\bwindow\.location\.reload\s*\(/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(p));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

const clientFiles = [...files("app/(app)"), ...files("components")].map((f) => f.split(path.sep).join("/"));

function mutates(file: string): boolean {
  const src = fs.readFileSync(file, "utf8");
  return /\bfetch\s*\(/.test(src) && MUTATING_METHOD.test(src);
}

describe("client mutations refresh the router (CLAUDE.md §17)", () => {
  it("finds the mutating client files (the scanner still works)", () => {
    const found = clientFiles.filter(mutates);
    expect(found).toContain("app/(app)/bills/bills-client.tsx");
    expect(found).toContain("app/(app)/settings/settings-client.tsx");
    expect(found.length).toBeGreaterThan(10);
  });

  it("every file with a mutating fetch refreshes, or is allowlisted with a reason", () => {
    const offenders = clientFiles
      .filter((f) => !(f in ALLOWLIST))
      .filter((f) => mutates(f) && !REFRESHES.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("allowlist entries still exist, still mutate, and do not refresh themselves", () => {
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, file).toBeGreaterThan(10);
      expect(clientFiles, file).toContain(file);
      expect(mutates(file), `${file} no longer mutates: drop it from the allowlist`).toBe(true);
      expect(
        REFRESHES.test(fs.readFileSync(file, "utf8")),
        `${file} refreshes itself now: drop it from the allowlist`,
      ).toBe(false);
    }
  });
});
