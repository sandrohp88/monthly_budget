import { NextResponse } from "next/server";
import { ZodError, ZodSchema } from "zod";
import { getCurrentUserId } from "./auth";
import { log } from "./log";

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

export function jsonError(message: string, status = 500) {
  log.error(message);
  return NextResponse.json({ error: message }, { status });
}
