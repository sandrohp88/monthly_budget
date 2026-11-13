import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Review 2026-11-10 DATA-2/DATA-3. A client `fetch` that writes data does not
// invalidate Next's client router cache, and the shared (app) layout (sidebar
// net position, 30-day delta) is not re-rendered on client navigation. Every
// client mutation of server-rendered data must call `refreshAfterMutation()`
// (the function `useRefreshAfterMutation()` returns, lib/refresh-after-mutation.ts)
// on success. A bare `router.refresh()` is not enough: a navigation discards it
// while it is pending. See CLAUDE.md §17 "Client cache invalidation after
// mutations".
//
// The check counts, per file, mutating `fetch(...)` call sites (a POST, PUT,
// PATCH or DELETE literal, or a `method` shorthand, inside the call's
// arguments) and `refreshAfterMutation()` / `window.location.reload()` calls.
// The two counts must be equal, or differ by exactly the number listed below
// with a reason: positive = fetches that legitimately do not refresh here,
// negative = refreshes that serve a fetch made elsewhere (a child component's
// callback, or one shared helper called by several handlers). Exact, so that
// removing a refresh from a file with extra ones still fails.

const FETCHES_MINUS_REFRESHES: Record<string, { count: number; reason: string }> = {
  "app/(app)/credit-cards/card-dialogs.tsx": {
    count: 7,
    reason: "dialogs only; every onSaved caller refreshes (credit-cards-client reloads, card-detail-client refreshes)",
  },
  "components/promo-reconcile-dialog.tsx": {
    count: 1,
    reason: "dialog only; its one caller (card-detail-client onApplied) refreshes",
  },
  "app/(app)/paychecks/schedule-dialog.tsx": {
    count: 2,
    reason: "the preview POST writes nothing; apply goes to onApplied, and paychecks-client refreshes there",
  },
  "components/plaid-link-button.tsx": {
    count: 2,
    reason: "the link-token POST writes nothing rendered; the exchange result goes to onLinked, and accounts-client refreshes there",
  },
  "components/push-notifications-card.tsx": {
    count: 2,
    reason: "push subscribe/unsubscribe/test; push state is read client-side from /api/push, no server render uses it",
  },
  "app/(app)/bills/bills-client.tsx": {
    count: 1,
    reason: "POST /api/variable-bills/average only reads",
  },
  "app/(app)/settings/settings-client.tsx": {
    count: 5,
    reason:
      "import preview only reads; creating/deleting another user and the admin password reset change no page of yours; your own password change signs you out",
  },
  "components/pending-posting-alert.tsx": {
    count: 2,
    reason: "each handler picks one of two fetches (PUT or DELETE; DELETE, then DELETE with unlink=1) and refreshes once",
  },
  "app/(app)/calendar/calendar-client.tsx": {
    count: -4,
    reason: "applyCardPaymentOps holds the one card-payment fetch; five handlers call it and each refreshes",
  },
  "app/(app)/accounts/accounts-client.tsx": {
    count: -2,
    reason: "the two PlaidLinkButton onLinked handlers refresh for the button's exchange POST",
  },
  "app/(app)/paychecks/paychecks-client.tsx": {
    count: -2,
    reason: "CreatePaycheckForm is mounted twice (each onCreated refreshes for its one POST); ScheduleDialog onApplied refreshes for the dialog's apply POST",
  },
};

const MUTATING_METHOD = /["'`](POST|PUT|PATCH|DELETE)["'`]/;
const REFRESH_CALL = /\brefreshAfterMutation\s*\(\s*\)|\bwindow\.location\.reload\s*\(/g;

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
const read = (f: string) => fs.readFileSync(f, "utf8");
const withoutComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");

/** The text of a call's argument list, from its "(" to the matching ")". */
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

function mutatingFetches(src: string): number {
  let n = 0;
  for (const m of src.matchAll(/\bfetch\s*\(/g)) {
    const args = callArgs(src, m.index! + m[0].length - 1);
    if (MUTATING_METHOD.test(args) || /\bmethod\s*[,}]/.test(args)) n++;
  }
  return n;
}

const refreshCalls = (src: string) => (src.match(REFRESH_CALL) ?? []).length;

describe("client mutations refresh the router (CLAUDE.md §17)", () => {
  it("finds the mutating client files (the scanner still works)", () => {
    expect(mutatingFetches(read("app/(app)/bills/bills-client.tsx"))).toBeGreaterThanOrEqual(9);
    expect(mutatingFetches(read("app/(app)/settings/settings-client.tsx"))).toBeGreaterThanOrEqual(10);
    expect(clientFiles.filter((f) => mutatingFetches(read(f)) > 0).length).toBeGreaterThan(15);
  });

  it("every mutating fetch has a refresh call, except the listed differences", () => {
    const wrong: string[] = [];
    for (const f of clientFiles) {
      const src = withoutComments(read(f));
      const fetches = mutatingFetches(src);
      if (fetches === 0 && !(f in FETCHES_MINUS_REFRESHES)) continue;
      const diff = fetches - refreshCalls(src);
      const expected = FETCHES_MINUS_REFRESHES[f]?.count ?? 0;
      if (diff !== expected) wrong.push(`${f}: mutating fetches - refresh calls = ${diff}, expected ${expected}`);
    }
    expect(wrong).toEqual([]);
  });

  it("listed differences name a file that exists, with a reason", () => {
    for (const [file, { reason }] of Object.entries(FETCHES_MINUS_REFRESHES)) {
      expect(clientFiles, file).toContain(file);
      expect(reason.length, file).toBeGreaterThan(10);
    }
  });

  it("no bare router.refresh(): a navigation discards it while it is pending", () => {
    const bare = clientFiles.filter((f) => /\brouter\.refresh\s*\(/.test(withoutComments(read(f))));
    expect(bare).toEqual([]);
  });

  it("the hook's function is always named refreshAfterMutation (so it is counted)", () => {
    const misnamed: string[] = [];
    for (const f of clientFiles) {
      for (const m of read(f).matchAll(/^.*\buseRefreshAfterMutation\s*\(\s*\).*$/gm)) {
        if (!/const refreshAfterMutation = useRefreshAfterMutation\(\);/.test(m[0])) misnamed.push(`${f}: ${m[0].trim()}`);
      }
    }
    expect(misnamed).toEqual([]);
  });
});
