import { describe, expect, it } from "vitest";
import {
  assessBankHealth,
  assessItemHealth,
  BANK_SYNC_STALE_AFTER_MS,
  bankHealthAction,
  bankHealthLastSyncLabel,
  bankHealthReason,
  bankHealthShortLabel,
  LOGIN_TYPE_CODES,
  isLoginTypeCode,
  normalizeItemErrorCode,
  syncFailureMessage,
  UNKNOWN_ERROR_CODE,
  type BankItemHealthInput,
} from "./plaid-item-health";
import { isoDateInTimeZone } from "./dates";

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0); // 2026-09-22 12:00 UTC
const HOUR = 3_600_000;

function item(overrides: Partial<BankItemHealthInput> = {}): BankItemHealthInput {
  return {
    id: "item-1",
    institutionName: "Chase",
    lastSyncedAt: NOW - HOUR,
    createdAt: NOW - 100 * 24 * HOUR,
    lastErrorCode: null,
    lastErrorAt: null,
    ...overrides,
  };
}

describe("assessItemHealth", () => {
  it("is ok after a recent successful sync with no error", () => {
    expect(assessItemHealth(item(), NOW).status).toBe("ok");
  });

  it("stays ok at exactly the threshold and turns stale one millisecond past it", () => {
    const at = item({ lastSyncedAt: NOW - BANK_SYNC_STALE_AFTER_MS });
    expect(assessItemHealth(at, NOW).status).toBe("ok");
    const past = item({ lastSyncedAt: NOW - BANK_SYNC_STALE_AFTER_MS - 1 });
    expect(assessItemHealth(past, NOW).status).toBe("stale");
  });

  it("uses the link time when the item has never synced", () => {
    const fresh = item({ lastSyncedAt: null, createdAt: NOW - HOUR });
    expect(assessItemHealth(fresh, NOW).status).toBe("ok");
    const old = item({ lastSyncedAt: null, createdAt: NOW - BANK_SYNC_STALE_AFTER_MS - 1 });
    expect(assessItemHealth(old, NOW)).toMatchObject({ status: "stale", lastSuccessAt: null });
  });

  it("is failing for a stored sync error, even right after a success", () => {
    const h = assessItemHealth(item({ lastErrorCode: "ITEM_LOGIN_REQUIRED" }), NOW);
    expect(h).toMatchObject({ status: "failing", code: "ITEM_LOGIN_REQUIRED" });
  });

  it("is expiring for a pending re-authentication code while syncs still succeed", () => {
    expect(assessItemHealth(item({ lastErrorCode: "PENDING_EXPIRATION" }), NOW).status).toBe(
      "expiring",
    );
    expect(assessItemHealth(item({ lastErrorCode: "PENDING_DISCONNECT" }), NOW).status).toBe(
      "expiring",
    );
  });

  it("reports stale before expiring when the expiring item also stopped syncing", () => {
    const h = assessItemHealth(
      item({ lastErrorCode: "PENDING_EXPIRATION", lastSyncedAt: NOW - BANK_SYNC_STALE_AFTER_MS - 1 }),
      NOW,
    );
    expect(h.status).toBe("stale");
  });

  it("does not depend on the process timezone: inputs are epoch milliseconds", () => {
    const original = process.env.TZ;
    const results: string[] = [];
    try {
      for (const tz of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        results.push(
          assessItemHealth(item({ lastSyncedAt: NOW - BANK_SYNC_STALE_AFTER_MS - 1 }), NOW).status,
        );
      }
    } finally {
      process.env.TZ = original;
    }
    expect(results).toEqual(["stale", "stale", "stale"]);
  });
});

describe("assessBankHealth", () => {
  it("raises the dashboard alert only for an unhealthy item that feeds the starting balance", () => {
    const broken = item({ id: "broken", institutionName: "Chase", lastErrorCode: "ITEM_LOGIN_REQUIRED" });
    const healthy = item({ id: "healthy", institutionName: "Alliant" });
    const report = assessBankHealth({
      items: [healthy, broken],
      accounts: [
        { itemId: "healthy", useAsStartingBalance: true },
        { itemId: "broken", useAsStartingBalance: true },
      ],
      now: NOW,
    });
    expect(report.unhealthy.map((h) => h.itemId)).toEqual(["broken"]);
    expect(report.dashboard.map((h) => h.itemId)).toEqual(["broken"]);
    expect(report.balanceOutOfDate.map((h) => h.itemId)).toEqual(["broken"]);
  });

  it("no starting-balance account: no dashboard alert, but /accounts still warns", () => {
    const broken = item({ lastErrorCode: "ITEM_LOGIN_REQUIRED" });
    const report = assessBankHealth({
      items: [broken],
      accounts: [{ itemId: "item-1", useAsStartingBalance: false }],
      now: NOW,
    });
    expect(report.unhealthy).toHaveLength(1);
    expect(report.dashboard).toEqual([]);
    expect(report.balanceOutOfDate).toEqual([]);
  });

  it("a stale anchor makes the balance out of date; an expiring one only alerts", () => {
    const stale = item({ id: "stale", lastSyncedAt: NOW - BANK_SYNC_STALE_AFTER_MS - 1 });
    const expiring = item({ id: "expiring", lastErrorCode: "PENDING_EXPIRATION" });
    const report = assessBankHealth({
      items: [stale, expiring],
      accounts: [
        { itemId: "stale", useAsStartingBalance: true },
        { itemId: "expiring", useAsStartingBalance: true },
      ],
      now: NOW,
    });
    expect(report.dashboard.map((h) => h.itemId)).toEqual(["stale", "expiring"]);
    expect(report.balanceOutOfDate.map((h) => h.itemId)).toEqual(["stale"]);
  });

  it("names the unhealthy item with the OLDEST last success, so one healthy item cannot hide a broken one", () => {
    const healthy = item({ id: "healthy", institutionName: "Alliant", lastSyncedAt: NOW - HOUR });
    const broken = item({
      id: "broken",
      institutionName: "Chase",
      lastSyncedAt: NOW - 7 * 24 * HOUR,
      lastErrorCode: "ITEM_LOGIN_REQUIRED",
    });
    const stale = item({
      id: "stale",
      institutionName: "Navy",
      lastSyncedAt: NOW - BANK_SYNC_STALE_AFTER_MS - 1,
    });
    const report = assessBankHealth({ items: [healthy, stale, broken], accounts: [], now: NOW });
    expect(report.oldestUnhealthy).toMatchObject({
      itemId: "broken",
      lastSuccessAt: NOW - 7 * 24 * HOUR,
    });
  });

  it("a just-linked, never-synced healthy item does not hide the broken one", () => {
    const fresh = item({ id: "fresh", lastSyncedAt: null, createdAt: NOW - HOUR });
    const broken = item({ id: "broken", lastErrorCode: "ITEM_LOGIN_REQUIRED" });
    const report = assessBankHealth({ items: [fresh, broken], accounts: [], now: NOW });
    expect(report.oldestUnhealthy?.itemId).toBe("broken");
  });

  it("treats a never-synced unhealthy item as the oldest", () => {
    const never = item({ id: "never", lastSyncedAt: null, createdAt: NOW - 30 * 24 * HOUR });
    const broken = item({ id: "broken", lastErrorCode: "ITEM_LOGIN_REQUIRED" });
    const report = assessBankHealth({ items: [broken, never], accounts: [], now: NOW });
    expect(report.oldestUnhealthy?.itemId).toBe("never");
  });

  it("is null when every item is ok", () => {
    expect(assessBankHealth({ items: [item()], accounts: [], now: NOW }).oldestUnhealthy).toBeNull();
  });
});

describe("error codes and wording", () => {
  it("keeps only short stable codes; anything else becomes UNKNOWN_ERROR", () => {
    expect(normalizeItemErrorCode("ITEM_LOGIN_REQUIRED")).toBe("ITEM_LOGIN_REQUIRED");
    expect(normalizeItemErrorCode("access-sandbox-1234 secret")).toBe(UNKNOWN_ERROR_CODE);
    expect(normalizeItemErrorCode("A".repeat(65))).toBe(UNKNOWN_ERROR_CODE);
    expect(normalizeItemErrorCode(null)).toBe(UNKNOWN_ERROR_CODE);
    expect(normalizeItemErrorCode(42)).toBe(UNKNOWN_ERROR_CODE);
  });

  it("classifies login-type codes", () => {
    expect(isLoginTypeCode("ITEM_LOGIN_REQUIRED")).toBe(true);
    expect(isLoginTypeCode("USER_PERMISSION_REVOKED")).toBe(true);
    expect(isLoginTypeCode("PENDING_EXPIRATION")).toBe(true);
    expect(isLoginTypeCode("INSTITUTION_DOWN")).toBe(false);
    expect(isLoginTypeCode(UNKNOWN_ERROR_CODE)).toBe(false);
  });

  it("names the bank in the sync toast", () => {
    expect(
      syncFailureMessage([{ institutionName: "Chase", code: "ITEM_LOGIN_REQUIRED" }]),
    ).toBe("Chase needs to be reconnected. See Accounts for details.");
    expect(
      syncFailureMessage([
        { institutionName: "Chase", code: "ITEM_LOGIN_REQUIRED" },
        { institutionName: "Alliant", code: "INSTITUTION_DOWN" },
      ]),
    ).toBe("Chase needs to be reconnected. Could not sync Alliant. See Accounts for details.");
  });

  it("tells the user that unlink and re-link is the only recovery for a login problem", () => {
    const h = assessItemHealth(item({ lastErrorCode: "ITEM_LOGIN_REQUIRED" }), NOW);
    expect(bankHealthReason(h)).toMatch(/sign in again/i);
    expect(bankHealthAction(h)).toMatch(/unlink this bank/i);
    expect(bankHealthAction(h)).toMatch(/link it again/i);
  });
});

// Review of PR #172 (B1, S1): the per-item catch catches EVERY exception —
// our own bugs and config errors too. Unlinking cannot fix those and loses
// state (pending drafts dismissed, cards unlinked, a duplicate card on
// re-link until PLAID-3 is fixed), so only login-type codes may suggest it.
describe("bankHealthAction per code class", () => {
  const failing = (code: string) => assessItemHealth(item({ lastErrorCode: code }), NOW);

  it.each([...LOGIN_TYPE_CODES].filter((c) => !c.startsWith("PENDING_")))(
    "%s (login-type) suggests unlink + link again and states its cost",
    (code) => {
      const action = bankHealthAction(failing(code));
      expect(action).toMatch(/unlink this bank/i);
      expect(action).toMatch(/link it again/i);
      expect(action).toMatch(/removes this bank's pending transactions and its card links/i);
      expect(action).toMatch(/duplicate card/i);
    },
  );

  it.each(["UNKNOWN_ERROR", "INSTITUTION_DOWN", "INTERNAL_SERVER_ERROR", "RATE_LIMIT_EXCEEDED"])(
    "%s (not login-type) only suggests a retry and never unlinking",
    (code) => {
      const action = bankHealthAction(failing(code));
      expect(action).toBe(
        "Tap Sync now to try again. If it keeps failing, the problem may be in the app: check the server log.",
      );
      expect(action).not.toMatch(/unlink/i);
    },
  );

  it("an expiring connection does not suggest unlinking yet", () => {
    const action = bankHealthAction(assessItemHealth(item({ lastErrorCode: "PENDING_EXPIRATION" }), NOW));
    expect(action).not.toMatch(/unlink/i);
  });

  it("a stale item (no error) only suggests a sync", () => {
    const action = bankHealthAction(
      assessItemHealth(item({ lastSyncedAt: NOW - BANK_SYNC_STALE_AFTER_MS - 1 }), NOW),
    );
    expect(action).toBe("Tap Sync now to check for new data.");
  });

  it("a healthy item has no action", () => {
    expect(bankHealthAction(assessItemHealth(item(), NOW))).toBe("");
  });
});

describe("a failure after the cursor save (transactions were stored)", () => {
  // The per-item catch stamps such a failure with the cursor save's time.
  const savedAt = NOW - HOUR;

  it("says the last sync finished with an error, not 'not syncing since'", () => {
    const h = assessItemHealth(
      item({ lastSyncedAt: savedAt, lastErrorAt: savedAt, lastErrorCode: "UNKNOWN_ERROR" }),
      NOW,
    );
    expect(h).toMatchObject({ status: "failing", finishedWithError: true });
    expect(bankHealthShortLabel(h)).toBe("sync error");
    expect(bankHealthReason(h)).toBe(
      "The last sync finished with an error (UNKNOWN_ERROR). New transactions were saved, but balances may not be up to date.",
    );
    expect(bankHealthLastSyncLabel(h)).toBe("Last sync (finished with an error)");
  });

  it("a failure before the cursor save keeps the 'not syncing' wording", () => {
    const h = assessItemHealth(
      item({ lastSyncedAt: savedAt, lastErrorAt: NOW - 1000, lastErrorCode: "UNKNOWN_ERROR" }),
      NOW,
    );
    expect(h.finishedWithError).toBe(false);
    expect(bankHealthShortLabel(h)).toBe("not syncing");
    expect(bankHealthReason(h)).toBe("The last sync failed (UNKNOWN_ERROR).");
    expect(bankHealthLastSyncLabel(h)).toBe("Last successful sync");
  });

  it("a login-type code is never 'finished with an error'", () => {
    const h = assessItemHealth(
      item({ lastSyncedAt: savedAt, lastErrorAt: savedAt, lastErrorCode: "ITEM_LOGIN_REQUIRED" }),
      NOW,
    );
    expect(h.finishedWithError).toBe(false);
    expect(bankHealthShortLabel(h)).toBe("not syncing");
  });
});

describe("staleness threshold", () => {
  it("is 4 days so a holiday weekend (Fri 17:00 → Tue 05:00) raises no alarm", () => {
    expect(BANK_SYNC_STALE_AFTER_MS).toBe(4 * 24 * HOUR);
    const friday = Date.UTC(2026, 8, 4, 21, 0); // Fri 17:00 New York
    const tuesday = Date.UTC(2026, 8, 8, 9, 0); // Tue 05:00 New York, after Labor Day
    expect(assessItemHealth(item({ lastSyncedAt: friday }), tuesday).status).toBe("ok");
  });

  it("the stale reason states the threshold", () => {
    const h = assessItemHealth(item({ lastSyncedAt: NOW - BANK_SYNC_STALE_AFTER_MS - 1 }), NOW);
    expect(bankHealthReason(h)).toBe("No successful sync in more than 4 days.");
    expect(bankHealthShortLabel(h)).toBe("no recent sync");
  });
});

describe("isoDateInTimeZone", () => {
  it("formats an instant as the calendar date in the given zone, not UTC", () => {
    const lateEvening = Date.UTC(2026, 8, 16, 2, 30); // Sep 15 22:30 in New York
    expect(isoDateInTimeZone(lateEvening, "America/New_York")).toBe("2026-09-15");
    expect(isoDateInTimeZone(lateEvening, "UTC")).toBe("2026-09-16");
  });
});
