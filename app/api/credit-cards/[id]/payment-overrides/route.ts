import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import {
  deleteCreditCardPaymentOverride,
  getCreditCard,
  upsertCreditCardPaymentOverride,
} from "@/lib/repos";
import { creditCardPaymentOverrideSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const card = await getCreditCard(auth.userId, id);
  if (!card) return jsonError("not found", 404);

  const data = await readJson(req, creditCardPaymentOverrideSchema);
  if (data instanceof NextResponse) return data;

  const override = await upsertCreditCardPaymentOverride(auth.userId, id, {
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
  const card = await getCreditCard(auth.userId, id);
  if (!card) return jsonError("not found", 404);

  const url = new URL(req.url);
  const dueDate = url.searchParams.get("dueDate");
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return jsonError("dueDate is required", 400);
  }

  await deleteCreditCardPaymentOverride(auth.userId, id, dueDate);
  return NextResponse.json({ ok: true });
}
