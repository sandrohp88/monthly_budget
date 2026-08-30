import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { paycheckCreateSchema } from "@/lib/validation";
import { createPaycheck, listPaychecks } from "@/lib/repos";

export async function GET() {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ paychecks: await listPaychecks(auth.userId) });
}

export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const data = await readJson(req, paycheckCreateSchema);
  if (data instanceof NextResponse) return data;
  try {
    const created = await createPaycheck(auth.userId, {
      payDate: data.payDate,
      amountCents: data.amountCents,
      note: data.note ?? null,
    });
    return NextResponse.json({ paycheck: created });
  } catch (e) {
    return jsonError((e as Error).message ?? "create failed");
  }
}
