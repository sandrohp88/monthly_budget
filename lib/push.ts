/**
 * Web-push I/O: VAPID config, per-user interest-alert dispatch, and dead-
 * subscription pruning. Pure payload/decision logic lives in
 * lib/push-payload.ts; the hourly trigger lives in lib/push-scheduler.ts.
 *
 * Dispatch semantics: for every user with at least one push subscription,
 * rebuild the projection, run findUncoveredCardDues (same detector as the
 * dashboard INTEREST AlertBar), and send at most one notification per
 * subscription per state change (or per 24h while the state persists) inside
 * local daytime hours. Subscriptions the push service reports gone (404/410)
 * are deleted.
 */

import webpush from "web-push";
import { todayIso } from "./dates";
import { findUncoveredCardDues } from "./projection-insights";
import { buildProjection } from "./projection-server";
import {
  deletePushSubscriptionById,
  getSettings,
  listAllPushSubscriptions,
  listPushSubscriptions,
  markPushSubscriptionNotified,
} from "./repos";
import {
  buildInterestPushPayload,
  interestDigest,
  localHourInTimeZone,
  shouldSendInterestPush,
  type PushPayload,
} from "./push-payload";
import type { PushSubscriptionRow } from "./db/schema";

/** Horizon must match the dashboard alert (app/(app)/page.tsx). */
const PUSH_ALERT_HORIZON_DAYS = 14;

export function isPushConfigured(): boolean {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT,
  );
}

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

let vapidReady = false;
function ensureVapid(): void {
  if (vapidReady) return;
  if (!isPushConfigured()) throw new Error("web push is not configured (VAPID_* env vars)");
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT!,
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );
  vapidReady = true;
}

export type PushSendResult = "sent" | "pruned" | "failed";

/**
 * Send one payload to one subscription. Deletes the row when the push
 * service says the subscription no longer exists (404/410).
 */
async function sendToSubscription(
  sub: PushSubscriptionRow,
  payload: PushPayload,
): Promise<PushSendResult> {
  ensureVapid();
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 12 * 60 * 60, urgency: "normal" },
    );
    return "sent";
  } catch (e) {
    const statusCode = (e as { statusCode?: number }).statusCode;
    if (statusCode === 404 || statusCode === 410) {
      await deletePushSubscriptionById(sub.id);
      return "pruned";
    }
    console.error(`[push] send failed (${statusCode ?? "?"}) for sub ${sub.id}:`, e);
    return "failed";
  }
}

export type DispatchSummary = {
  usersChecked: number;
  sent: number;
  skipped: number;
  pruned: number;
  failed: number;
};

/**
 * Run the interest-alert check for every subscribed user (or one user when
 * `userId` is given). `force` bypasses the digest/24h/quiet-hours gate —
 * used by the settings test button so a tap always produces a notification.
 */
export async function dispatchInterestAlerts(opts?: {
  userId?: string;
  force?: boolean;
}): Promise<DispatchSummary> {
  const summary: DispatchSummary = { usersChecked: 0, sent: 0, skipped: 0, pruned: 0, failed: 0 };
  if (!isPushConfigured()) return summary;

  const subs = opts?.userId
    ? await listPushSubscriptions(opts.userId)
    : await listAllPushSubscriptions();
  const byUser = new Map<string, PushSubscriptionRow[]>();
  for (const s of subs) {
    const list = byUser.get(s.userId) ?? [];
    list.push(s);
    byUser.set(s.userId, list);
  }

  const now = new Date();
  for (const [userId, userSubs] of byUser) {
    summary.usersChecked++;
    const settings = await getSettings(userId);
    if (!settings) continue;
    const projection = await buildProjection(userId);
    if (!projection) continue;

    const today = todayIso(settings.timezone);
    const dues = findUncoveredCardDues(projection.rows, {
      today,
      horizonDays: PUSH_ALERT_HORIZON_DAYS,
    });
    if (dues.length === 0) continue;

    const payload = buildInterestPushPayload(dues, settings.currency);
    if (!payload) continue;
    const digest = interestDigest(dues);
    const localHour = localHourInTimeZone(now, settings.timezone);

    for (const sub of userSubs) {
      const send =
        opts?.force === true ||
        shouldSendInterestPush({
          digest,
          lastDigest: sub.lastDigest,
          lastNotifiedAt: sub.lastNotifiedAt,
          nowMs: now.getTime(),
          localHour,
        });
      if (!send) {
        summary.skipped++;
        continue;
      }
      const result = await sendToSubscription(sub, payload);
      summary[result === "sent" ? "sent" : result === "pruned" ? "pruned" : "failed"]++;
      if (result === "sent") {
        await markPushSubscriptionNotified(sub.id, digest, now.getTime());
      }
    }
  }
  return summary;
}

/**
 * Settings-page test button: send the real interest alert when one is
 * pending, else a generic "push works" notification. Never updates digests —
 * a test must not swallow the next scheduled alert.
 */
export async function sendTestPush(
  userId: string,
): Promise<{ sent: number; pruned: number; failed: number; interestAlert: boolean }> {
  const subs = await listPushSubscriptions(userId);
  const settings = await getSettings(userId);
  let payload: PushPayload | null = null;
  if (settings) {
    const projection = await buildProjection(userId);
    if (projection) {
      const dues = findUncoveredCardDues(projection.rows, {
        today: todayIso(settings.timezone),
        horizonDays: PUSH_ALERT_HORIZON_DAYS,
      });
      payload = buildInterestPushPayload(dues, settings.currency);
    }
  }
  const interestAlert = payload != null;
  payload ??= {
    title: "FINANCE_OS push is working",
    body: "This device will be notified when a card balance is due with no planned payment.",
    url: "/",
    tag: "push-test",
  };
  const out = { sent: 0, pruned: 0, failed: 0, interestAlert };
  for (const sub of subs) {
    const result = await sendToSubscription(sub, payload);
    out[result === "sent" ? "sent" : result === "pruned" ? "pruned" : "failed"]++;
  }
  return out;
}
