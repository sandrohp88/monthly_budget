import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { pushSubscribeSchema, pushUnsubscribeSchema } from "@/lib/validation";
import {
  deletePushSubscriptionByEndpoint,
  listPushSubscriptions,
  upsertPushSubscription,
} from "@/lib/repos";
import { isPushConfigured, vapidPublicKey } from "@/lib/push";

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
