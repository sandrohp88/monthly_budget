import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { paycheckUpdateSchema } from "@/lib/validation";
import { deletePaycheck, getPaycheck, updatePaycheck } from "@/lib/repos";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const data = await readJson(req, paycheckUpdateSchema);
  if (data instanceof NextResponse) return data;
  try {
    const updated = await updatePaycheck(auth.userId, id, {
      payDate: data.payDate,
      amountCents: data.amountCents,
      note: data.note ?? null,
      actualReceived: data.actualReceived ?? false,
      actualAmountCents: data.actualAmountCents ?? null,
    });
    if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ paycheck: updated });
  } catch (e) {
    return jsonError((e as Error).message ?? "update failed");
  }
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const existing = await getPaycheck(auth.userId, id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  await deletePaycheck(auth.userId, id);
  return NextResponse.json({ ok: true });
}
