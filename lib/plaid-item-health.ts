/**
 * Bank connection (Plaid item) health — pure, client-safe, unit-tested.
 *
 * Why this exists (review 2026-11-10 PLAID-2, incident 2026-09-15): a bank
 * login broke, every sync for that item failed inside the per-item catch, and
 * nothing anywhere said so. Its frozen balance and old pending holds kept
 * feeding the projection under a "live" label for a week. The sync and the
 * ITEM webhooks now RECORD an error code on `plaid_items` (migration 0045);
 * this module decides what that means for the UI. It changes no number.
 *
 * Inputs are epoch milliseconds only, so the result does not depend on any
 * timezone. Format dates for display with `isoDateInTimeZone` + `<DateLabel>`.
 */
import { DAY_MS } from "./dates";

/**
 * How long an item may go without a successful sync before the app says its
 * data may be out of date. Syncs here run only on Plaid webhooks and manual
 * taps (no timer, no sync on page load), and Plaid polls a bank 1–4 times a
 * day and sends a webhook only when something changed. So a healthy, quiet
 * account gets no sync while nothing posts. The longest normal quiet gap is a
 * holiday weekend: last posting Friday 17:00, next posting Tuesday 05:00 after
 * a Monday holiday = 3.5 days. 3 days raised a false alarm on Monday evening;
 * 4 days stays quiet through that gap and still catches the 2026-09-15 case
 * (a week unnoticed) in about half the time. A broken login is reported at
 * once anyway, by the sync error or Plaid's ITEM webhook; this threshold is
 * only the backstop when no sync runs at all.
 */
export const BANK_SYNC_STALE_AFTER_MS = 4 * DAY_MS;

/** Stored for an error that carries no usable Plaid code. */
export const UNKNOWN_ERROR_CODE = "UNKNOWN_ERROR";

/**
 * Webhook codes that mean "still works today, will stop soon; needs
 * re-authentication". A successful sync does NOT clear these (the bank still
 * works until it expires); LOGIN_REPAIRED or removing the item does.
 */
export const PENDING_REAUTH_CODES: ReadonlySet<string> = new Set([
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
]);

/**
 * Codes that only the user can fix, by signing in to the bank again through
 * Plaid Link. Only these may suggest unlinking the bank (the one recovery
 * today, because Link update mode is not built). Sources, Plaid API docs:
 * - "Errors > Item errors" (error_type ITEM_ERROR, resolved with Link update
 *   mode): ITEM_LOGIN_REQUIRED, INVALID_CREDENTIALS, INVALID_MFA,
 *   INVALID_UPDATED_USERNAME, ITEM_LOCKED, ACCESS_NOT_GRANTED,
 *   USER_PERMISSION_REVOKED.
 * - "Webhooks > Item": USER_PERMISSION_REVOKED (consent revoked at the bank),
 *   PENDING_EXPIRATION / PENDING_DISCONNECT (consent will expire; the item
 *   still works until then, and once it stops a sync returns
 *   ITEM_LOGIN_REQUIRED). Pending codes are in this set for classification,
 *   but their status is `expiring`, which never suggests unlinking.
 * Every other code (UNKNOWN_ERROR, INSTITUTION_DOWN, RATE_LIMIT, an app bug
 * or config error caught by the per-item catch) must NOT suggest unlinking:
 * unlinking cannot help and loses state (see `bankHealthAction`).
 */
export const LOGIN_TYPE_CODES: ReadonlySet<string> = new Set([
  "ITEM_LOGIN_REQUIRED",
  "INVALID_CREDENTIALS",
  "INVALID_MFA",
  "INVALID_UPDATED_USERNAME",
  "ITEM_LOCKED",
  "USER_PERMISSION_REVOKED",
  "ACCESS_NOT_GRANTED",
  ...PENDING_REAUTH_CODES,
]);

const REVOKED_CODES: ReadonlySet<string> = new Set(["USER_PERMISSION_REVOKED", "ACCESS_NOT_GRANTED"]);

const CODE_SHAPE = /^[A-Z0-9_]{1,64}$/;

/**
 * Keep only a short upper-case code. Anything else (free text, which may hold
 * a token or a message, or a missing value) becomes UNKNOWN_ERROR.
 */
export function normalizeItemErrorCode(raw: unknown): string {
  return typeof raw === "string" && CODE_SHAPE.test(raw) ? raw : UNKNOWN_ERROR_CODE;
}

export function isLoginTypeCode(code: string | null | undefined): boolean {
  return code != null && LOGIN_TYPE_CODES.has(code);
}

export type BankItemHealthInput = {
  id: string;
  institutionName: string;
  /** Last SUCCESSFUL sync (epoch ms), null if the item never synced. */
  lastSyncedAt: number | null;
  /** When the item was linked (epoch ms). Staleness reference before a first sync. */
  createdAt: number;
  lastErrorCode: string | null;
  /** When the current error was last seen (epoch ms). */
  lastErrorAt: number | null;
};

/**
 * - `failing`: the last sync (or a Plaid ERROR webhook) failed; data is frozen.
 * - `stale`: no error recorded, but no successful sync within the threshold.
 * - `expiring`: still syncing, but Plaid warned it will stop soon.
 */
export type BankItemStatus = "ok" | "failing" | "stale" | "expiring";

export type BankItemHealth = {
  itemId: string;
  institutionName: string;
  status: BankItemStatus;
  code: string | null;
  lastSuccessAt: number | null;
  /**
   * The failing sync saved new transactions before it threw: the per-item
   * catch records a failure AFTER the cursor save with `last_error_at` equal
   * to `last_synced_at`. Then "not syncing since <date>" would contradict
   * itself; the text says the last sync finished with an error instead.
   */
  finishedWithError: boolean;
  /** True when one of the item's accounts feeds the starting balance. */
  anchorsBalance: boolean;
};

export function assessItemHealth(
  item: BankItemHealthInput,
  now: number,
  staleAfterMs: number = BANK_SYNC_STALE_AFTER_MS,
  anchorsBalance = false,
): BankItemHealth {
  const code = item.lastErrorCode ?? null;
  const reference = item.lastSyncedAt ?? item.createdAt;
  const stale = now - reference > staleAfterMs;
  let status: BankItemStatus = "ok";
  if (code != null && !PENDING_REAUTH_CODES.has(code)) status = "failing";
  else if (stale) status = "stale";
  else if (code != null) status = "expiring";
  return {
    itemId: item.id,
    institutionName: item.institutionName,
    status,
    code,
    lastSuccessAt: item.lastSyncedAt ?? null,
    finishedWithError:
      status === "failing" &&
      !isLoginTypeCode(code) &&
      item.lastSyncedAt != null &&
      item.lastErrorAt === item.lastSyncedAt,
    anchorsBalance,
  };
}

export type BankHealthReport = {
  /** One entry per item, in input order. */
  items: BankItemHealth[];
  /** Every item that is not ok — /accounts warns for each. */
  unhealthy: BankItemHealth[];
  /** Unhealthy items that feed the starting balance — the dashboard alert. */
  dashboard: BankItemHealth[];
  /** Dashboard items whose data is frozen (failing or stale): the balance may be out of date. */
  balanceOutOfDate: BankItemHealth[];
  /**
   * Among UNHEALTHY items, the one with the oldest last success (never synced
   * counts as oldest); null when every item is ok. The /accounts tile shows
   * this instead of the newest sync, so one healthy item cannot hide a broken
   * one. Healthy items are left out on purpose: a bank linked a minute ago has
   * never synced, and naming it would hide the bank that actually failed.
   */
  oldestUnhealthy: BankItemHealth | null;
};

export function assessBankHealth(input: {
  items: readonly BankItemHealthInput[];
  accounts: readonly { itemId: string; useAsStartingBalance: boolean }[];
  now: number;
  staleAfterMs?: number;
}): BankHealthReport {
  const anchorItemIds = new Set(
    input.accounts.filter((a) => a.useAsStartingBalance).map((a) => a.itemId),
  );
  const items = input.items.map((item) =>
    assessItemHealth(item, input.now, input.staleAfterMs, anchorItemIds.has(item.id)),
  );
  const unhealthy = items.filter((h) => h.status !== "ok");
  const dashboard = unhealthy.filter((h) => h.anchorsBalance);
  const balanceOutOfDate = dashboard.filter((h) => h.status === "failing" || h.status === "stale");
  let oldest: BankItemHealth | null = null;
  for (const h of unhealthy) {
    if (oldest == null) oldest = h;
    else if (oldest.lastSuccessAt != null && (h.lastSuccessAt ?? -Infinity) < oldest.lastSuccessAt) {
      oldest = h;
    }
  }
  return { items, unhealthy, dashboard, balanceOutOfDate, oldestUnhealthy: oldest };
}

/** A few words for a pill or tile ("Chase not syncing"). */
export function bankHealthShortLabel(h: BankItemHealth): string {
  switch (h.status) {
    case "ok":
      return "syncing";
    case "failing":
      return h.finishedWithError ? "sync error" : "not syncing";
    case "stale":
      return "no recent sync";
    case "expiring":
      return "connection expires soon";
  }
}

/** The reason in plain words, for /accounts and the dashboard alert. */
export function bankHealthReason(h: BankItemHealth): string {
  switch (h.status) {
    case "ok":
      return "Syncing normally.";
    case "expiring":
      return "The bank connection expires soon. Then syncing will stop.";
    case "stale": {
      const days = Math.round(BANK_SYNC_STALE_AFTER_MS / DAY_MS);
      return `No successful sync in more than ${days} days.`;
    }
    case "failing":
      if (h.code != null && REVOKED_CODES.has(h.code)) {
        return "Access to this bank was turned off. Syncing has stopped.";
      }
      if (isLoginTypeCode(h.code)) return "The bank needs you to sign in again. Syncing has stopped.";
      if (h.finishedWithError) {
        return `The last sync finished with an error (${h.code ?? UNKNOWN_ERROR_CODE}). New transactions were saved, but balances may not be up to date.`;
      }
      return `The last sync failed (${h.code ?? UNKNOWN_ERROR_CODE}).`;
  }
}

/** The text before the date of `lastSuccessAt` ("Last successful sync Sep 15"). */
export function bankHealthLastSyncLabel(h: BankItemHealth): string {
  return h.finishedWithError ? "Last sync (finished with an error)" : "Last successful sync";
}

/**
 * What the user can do today.
 *
 * Only a LOGIN-type failure suggests unlinking. Plaid Link update mode is not
 * built, so unlink + link again is the one recovery for those — say so, with
 * its cost, instead of offering a Reconnect button that does nothing.
 * `deactivatePlaidItem` dismisses the bank's pending transactions and unlinks
 * its cards. Linking again re-links a card only when it can prove the card is
 * the same account (`matchRelinkCards`, PLAID-3); any other card comes back as
 * a duplicate.
 *
 * Every other failure (UNKNOWN_ERROR, INSTITUTION_DOWN, our own bugs and
 * config errors, which the per-item catch also catches) gets only "try again;
 * it may be the app": unlinking cannot fix those and loses state.
 */
export function bankHealthAction(h: BankItemHealth): string {
  switch (h.status) {
    case "ok":
      return "";
    case "expiring":
      return "It still syncs for now. When it stops, this page shows how to fix it.";
    case "stale":
      return "Tap Sync now to check for new data.";
    case "failing":
      if (isLoginTypeCode(h.code)) {
        return (
          "To fix this, unlink this bank with the trash button and link it again. " +
          "Reconnecting in place is not available yet. " +
          "Unlinking removes this bank's pending transactions and its card links. " +
          "Linking again reconnects each card it can match to its account; a card it cannot match comes back as a duplicate card: check the Credit cards page afterwards."
        );
      }
      return "Tap Sync now to try again. If it keeps failing, the problem may be in the app: check the server log.";
  }
}

/** Toast text after a manual sync in which one or more items failed. */
export function syncFailureMessage(
  errors: readonly { institutionName: string; code: string }[],
): string {
  const parts = errors.map((e) =>
    isLoginTypeCode(e.code)
      ? `${e.institutionName} needs to be reconnected.`
      : `Could not sync ${e.institutionName}.`,
  );
  return `${parts.join(" ")} See Accounts for details.`;
}
