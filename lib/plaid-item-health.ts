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
 * taps (no timer), and Plaid polls a bank 1–4 times a day and sends a webhook
 * only when something changed. An active checking account normally changes
 * at least every business day, so a normal weekend gap stays under 3 days
 * (Fri evening → Mon morning). 3 days is long enough to stay quiet then, and
 * short enough to catch the 2026-09-15 case in half the week it went
 * unnoticed. A false alarm on a long weekend clears with one tap of Sync now.
 */
export const BANK_SYNC_STALE_AFTER_MS = 3 * DAY_MS;

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

/** Codes the user can only fix by signing in to the bank again. */
const LOGIN_TYPE_CODES: ReadonlySet<string> = new Set([
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
      return "not syncing";
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
      return `The last sync failed (${h.code ?? UNKNOWN_ERROR_CODE}).`;
  }
}

/**
 * What the user can do today. Plaid Link update mode is not built yet, so
 * for a login problem the only recovery is to unlink the bank and link it
 * again — say so instead of offering a Reconnect button that does nothing.
 */
export function bankHealthAction(h: BankItemHealth): string {
  if (h.status === "ok") return "";
  if (h.status === "expiring" || isLoginTypeCode(h.code)) {
    return "To fix this, unlink this bank with the trash button and link it again. Reconnecting in place is not available yet.";
  }
  return "Tap Sync now to try again. If it keeps failing, unlink this bank and link it again.";
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
