import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import {
  deleteBillPaymentOverride,
  getBill,
  upsertBillPaymentOverride,
} from "@/lib/repos";
import { billPaymentOverrideSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const bill = await getBill(auth.userId, id);
  if (!bill) return jsonError("not found", 404);

  const data = await readJson(req, billPaymentOverrideSchema);
  if (data instanceof NextResponse) return data;

  const override = await upsertBillPaymentOverride(auth.userId, id, {
    dueDate: data.dueDate,
    amountCents: data.amountCents,
    notes: data.notes ?? null,
  });
  return NextResponse.json({ override });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const bill = await getBill(auth.userId, id);
  if (!bill) return jsonError("not found", 404);

  const url = new URL(req.url);
  const dueDate = url.searchParams.get("dueDate");
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return jsonError("dueDate is required", 400);
  }

  await deleteBillPaymentOverride(auth.userId, id, dueDate);
  return NextResponse.json({ ok: true });
}
