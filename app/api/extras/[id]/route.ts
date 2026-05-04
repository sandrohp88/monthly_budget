import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { extraUpdateSchema } from "@/lib/validation";
import { deleteExtra, getExtra, updateExtra } from "@/lib/repos";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const data = await readJson(req, extraUpdateSchema);
  if (data instanceof NextResponse) return data;
  try {
    const updated = await updateExtra(auth.userId, id, {
      date: data.date,
      description: data.description,
      amountCents: data.amountCents,
      category: data.category,
      paidViaCardId: data.paidViaCardId ?? null,
      notes: data.notes ?? null,
    });
    if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ extra: updated });
  } catch (e) {
    return jsonError((e as Error).message ?? "update failed");
  }
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const existing = await getExtra(auth.userId, id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  await deleteExtra(auth.userId, id);
  return NextResponse.json({ ok: true });
}
