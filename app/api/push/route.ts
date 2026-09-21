import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { pushSubscribeSchema, pushUnsubscribeSchema } from "@/lib/validation";
import {
  deletePushSubscriptionByEndpoint,
  listPushSubscriptions,
  upsertPushSubscription,
} from "@/lib/repos";
import { isPushConfigured, vapidPublicKey } from "@/lib/push";

const MAX_SUBSCRIPTIONS_PER_USER = 10;

/** Push status for the settings page: server config + this user's devices. */
export async function GET() {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const subs = await listPushSubscriptions(auth.userId);
  return NextResponse.json({
    configured: isPushConfigured(),
    publicKey: isPushConfigured() ? vapidPublicKey() : null,
    subscriptionCount: subs.length,
    endpoints: subs.map((s) => s.endpoint),
  });
}

export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const data = await readJson(req, pushSubscribeSchema);
  if (data instanceof NextResponse) return data;
  // A person has a handful of browsers; cap rows so one account can't fan
  // the hourly dispatcher out to thousands of endpoints.
  const existing = await listPushSubscriptions(auth.userId);
  if (existing.length >= MAX_SUBSCRIPTIONS_PER_USER && !existing.some((s) => s.endpoint === data.endpoint)) {
    return jsonError(`at most ${MAX_SUBSCRIPTIONS_PER_USER} devices can receive notifications`, 409);
  }
  try {
    await upsertPushSubscription(auth.userId, {
      endpoint: data.endpoint,
      p256dh: data.keys.p256dh,
      auth: data.keys.auth,
      userAgent: data.userAgent ?? null,
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    return jsonError((e as Error).message ?? "subscribe failed");
  }
}

export async function DELETE(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const data = await readJson(req, pushUnsubscribeSchema);
  if (data instanceof NextResponse) return data;
  await deletePushSubscriptionByEndpoint(auth.userId, data.endpoint);
  return NextResponse.json({ ok: true });
}
