import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { billUpdateSchema } from "@/lib/validation";
import { archiveBill, getBill, updateBill } from "@/lib/repos";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const bill = await getBill(auth.userId, id);
  if (!bill) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ bill });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const data = await readJson(req, billUpdateSchema);
  if (data instanceof NextResponse) return data;
  try {
    const updated = await updateBill(auth.userId, id, {
      name: data.name,
      category: data.category,
      amountCents: data.amountCents,
      frequency: data.frequency,
      dueDay: data.dueDay,
      dueMonth: data.dueMonth ?? null,
      autoPay: data.autoPay,
      paidViaCardId: data.paidViaCardId ? data.paidViaCardId : null,
      notes: data.notes ?? null,
      isActive: data.isActive ?? true,
    });
    if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ bill: updated });
  } catch (e) {
    return jsonError((e as Error).message ?? "update failed");
  }
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  await archiveBill(auth.userId, id);
  return NextResponse.json({ ok: true });
}
