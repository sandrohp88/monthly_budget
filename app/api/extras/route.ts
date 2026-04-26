import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { extraCreateSchema } from "@/lib/validation";
import { createExtra, listExtras } from "@/lib/repos";

export async function GET() {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ extras: await listExtras(auth.userId) });
}

export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const data = await readJson(req, extraCreateSchema);
  if (data instanceof NextResponse) return data;
  try {
    const created = await createExtra(auth.userId, {
      date: data.date,
      description: data.description,
      amountCents: data.amountCents,
      category: data.category,
      notes: data.notes ?? null,
    });
    return NextResponse.json({ extra: created });
  } catch (e) {
    return jsonError((e as Error).message ?? "create failed");
  }
}
