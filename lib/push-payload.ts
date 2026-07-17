/**
 * Pure web-push payload + dispatch-decision helpers for the interest alert.
 *
 * Everything here is deterministic for its inputs so it unit-tests without
 * touching web-push, the DB, or the projection loaders — the I/O side lives
 * in lib/push.ts. The alert semantics mirror the dashboard INTEREST AlertBar
 * (app/(app)/page.tsx): the input is findUncoveredCardDues() output, already
 * sorted soonest-due first.
 */

import { formatIso } from "./dates";
import type { UncoveredCardDue } from "./projection-insights";

/** JSON payload the service worker's `push` handler renders (public/sw.js). */
export type PushPayload = {
  title: string;
  body: string;
  /** In-app path opened by notificationclick. */
  url: string;
  /** Notification tag — same tag replaces, so repeats don't stack. */
  tag: string;
};

/** Re-nag cadence while an unchanged uncovered due persists. */
export const PUSH_RENOTIFY_MS = 24 * 60 * 60 * 1000;
/** Local quiet hours: no pushes before 08:00 or from 21:00. */
export const PUSH_QUIET_START_HOUR = 21;
export const PUSH_QUIET_END_HOUR = 8;

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/**
 * Stable fingerprint of the uncovered-dues state. A subscription that was
 * already notified for this exact digest is only re-notified after
 * PUSH_RENOTIFY_MS — but any change (new due, shortfall moved, a due covered
 * or cleared) notifies immediately.
 */
export function interestDigest(dues: readonly UncoveredCardDue[]): string {
  return dues.map((d) => `${d.cardId}:${d.dueDate}:${d.shortfallCents}`).join("|");
}

/** Compose the notification for a non-empty set of uncovered dues. */
export function buildInterestPushPayload(
  dues: readonly UncoveredCardDue[],
  currency: string,
): PushPayload | null {
  const first = dues[0];
  if (!first) return null;
  const totalShortfall = dues.reduce((s, d) => s + d.shortfallCents, 0);
  const title =
    dues.length === 1
      ? `${formatMoney(first.shortfallCents, currency)} due ${formatIso(first.dueDate, "short")} — no payment planned`
      : `${formatMoney(totalShortfall, currency)} uncovered on ${dues.length} cards`;
  const rest = dues.length - 1;
  const body =
    `No planned payment covers ${first.label} (${formatMoney(first.shortfallCents, currency)} due ` +
    `${formatIso(first.dueDate, "short")})` +
    (rest > 0 ? ` and ${rest} more` : "") +
    ". Uncovered balances accrue interest past the due date.";
  return { title, body, url: "/calendar", tag: "interest-alert" };
}

/**
 * Hour-of-day (0–23) in an IANA timezone. Falls back to UTC on a bad zone so
 * a corrupted setting degrades to a wrong send *hour*, never a crash.
 */
export function localHourInTimeZone(now: Date, timeZone: string): number {
  try {
    const hour = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone,
    }).formatToParts(now).find((p) => p.type === "hour")?.value;
    return Number(hour ?? now.getUTCHours());
  } catch {
    return now.getUTCHours();
  }
}

/**
 * Send when the state changed, or daily while it persists — never during
 * local quiet hours. Quiet-hour suppression does not mark the subscription
 * notified, so the send happens on the first daytime tick.
 */
export function shouldSendInterestPush(input: {
  digest: string;
  lastDigest: string | null;
  lastNotifiedAt: number | null;
  nowMs: number;
  localHour: number;
}): boolean {
  if (input.localHour < PUSH_QUIET_END_HOUR || input.localHour >= PUSH_QUIET_START_HOUR) {
    return false;
  }
  if (input.digest !== input.lastDigest) return true;
  if (input.lastNotifiedAt == null) return true;
  return input.nowMs - input.lastNotifiedAt >= PUSH_RENOTIFY_MS;
}
