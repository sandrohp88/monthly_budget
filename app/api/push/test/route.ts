import { NextResponse } from "next/server";
import { ensureUser, jsonError } from "@/lib/api";
import { isPushConfigured, sendTestPush } from "@/lib/push";

/**
 * Settings-page "send test" button: pushes the pending interest alert when
 * one exists (the real payload, gates bypassed), else a generic
 * push-is-working notification, to every device this user subscribed.
 */
export async function POST() {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  if (!isPushConfigured()) return jsonError("web push is not configured on the server", 503);
  try {
    const result = await sendTestPush(auth.userId);
    return NextResponse.json(result);
  } catch (e) {
    return jsonError((e as Error).message ?? "test push failed");
  }
}
