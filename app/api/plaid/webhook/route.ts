import { NextResponse } from "next/server";
import { jsonError } from "@/lib/api";
import { plaidWebhookSchema } from "@/lib/validation";
import {
  getPlaidWebhookKey,
  handlePlaidWebhook,
  verifyPlaidWebhook,
} from "@/lib/plaid-webhook";
import { log } from "@/lib/log";

/**
 * Plaid webhook receiver. Unauthenticated by nature (Plaid has no session) —
 * the middleware allowlists this exact path and rate-limits it per IP; the
 * JWT signature check below is the actual authentication. The raw body must
 * be read before parsing because the signature binds its exact bytes.
 */
export async function POST(req: Request) {
  const token = req.headers.get("plaid-verification");
  if (!token) return jsonError("missing plaid-verification header", 401);

  const rawBody = await req.text();
  const verdict = await verifyPlaidWebhook({ rawBody, token, getKey: getPlaidWebhookKey });
  if (!verdict.ok) {
    log.warn(`plaid-webhook: rejected: ${verdict.reason}`);
    return jsonError("webhook verification failed", 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return jsonError("invalid json", 400);
  }
  const body = plaidWebhookSchema.safeParse(parsed);
  if (!body.success) return jsonError("malformed webhook payload", 400);

  const outcome = await handlePlaidWebhook(body.data);
  return NextResponse.json({ received: true, ...outcome });
}
