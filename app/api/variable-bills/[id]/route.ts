import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { variableBillUpdateSchema } from "@/lib/validation";
import { archiveVariableBill, getVariableBill, updateVariableBill } from "@/lib/repos";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const variableBill = await getVariableBill(auth.userId, id);
  if (!variableBill) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ variableBill });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const data = await readJson(req, variableBillUpdateSchema);
  if (data instanceof NextResponse) return data;
  try {
    const updated = await updateVariableBill(auth.userId, id, {
      name: data.name,
      category: data.category,
      amountCents: data.amountCents,
      intervalMonths: data.intervalMonths,
      anchorDate: data.anchorDate,
      notes: data.notes ?? null,
      isActive: data.isActive ?? true,
      cardIds: data.cardIds,
    });
    if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ variableBill: updated });
  } catch (e) {
    return jsonError((e as Error).message ?? "update failed");
  }
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  await archiveVariableBill(auth.userId, id);
  return NextResponse.json({ ok: true });
}
