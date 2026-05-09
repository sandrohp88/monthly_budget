import { NextResponse } from "next/server";
import { ZodError, ZodSchema } from "zod";
import { getCurrentUserId } from "./auth";
import { log } from "./log";
import { newRequestId } from "./security";

export async function ensureUser(): Promise<{ userId: string } | NextResponse> {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return { userId };
}

export async function readJson<T>(req: Request, schema: ZodSchema<T>): Promise<T | NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const err = (parsed as { error: ZodError }).error;
    const issue = err.issues[0];
    return NextResponse.json(
      { error: issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid input" },
      { status: 400 },
    );
  }
  return parsed.data;
}

/**
 * Return a JSON error response. The `message` is server-side detail and is
 * NEVER returned to the client when `status >= 500` — those go out as a
 * generic "internal error" string with a `requestId` so the user can quote
 * it back to us and we can grep the server logs.
 *
 * For 4xx (caller-correctable), we surface the message verbatim because it
 * carries useful validation/state information ("amount must be non-negative").
 */
export function jsonError(message: string, status = 500) {
  if (status >= 500) {
    const requestId = newRequestId();
    log.error("server_error", { requestId, status, message });
    return NextResponse.json(
      { error: "internal error", requestId },
      { status },
    );
  }
  log.warn("client_error", { status, message });
  return NextResponse.json({ error: message }, { status });
}
