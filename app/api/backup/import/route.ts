import { NextResponse } from "next/server";
import { ensureUser, jsonError } from "@/lib/api";
import { importAll } from "@/lib/repos";

export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "expected object" }, { status: 400 });
  }
  try {
    await importAll(auth.userId, body as Record<string, unknown[]>);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return jsonError((e as Error).message ?? "import failed");
  }
}
