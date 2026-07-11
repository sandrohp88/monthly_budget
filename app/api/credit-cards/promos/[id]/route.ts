import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import { archivePromo, getPromo, updatePromo } from "@/lib/repos";
import { promoUpdateSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const existing = await getPromo(auth.userId, id);
  if (!existing) return jsonError("not found", 404);

  const data = await readJson(req, promoUpdateSchema);
  if (data instanceof NextResponse) return data;

  const updated = await updatePromo(auth.userId, id, {
    ...(data.description !== undefined ? { description: data.description.trim() } : {}),
    ...(data.originalAmountCents !== undefined
      ? { originalAmountCents: data.originalAmountCents }
      : {}),
    ...(data.remainingAmountCents !== undefined
      ? { remainingAmountCents: data.remainingAmountCents }
      : {}),
    ...(data.startDate !== undefined ? { startDate: data.startDate } : {}),
    ...(data.endDate !== undefined ? { endDate: data.endDate } : {}),
    ...(data.monthlyPaymentCents !== undefined
      ? { monthlyPaymentCents: data.monthlyPaymentCents ?? null }
      : {}),
    ...(data.notes !== undefined ? { notes: data.notes ?? null } : {}),
    ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    ...(data.authoritativeSource !== undefined
      ? { authoritativeSource: data.authoritativeSource ?? null }
      : {}),
    ...((data.originalAmountCents !== undefined ||
      data.remainingAmountCents !== undefined ||
      data.endDate !== undefined) &&
    data.authoritativeSource === undefined
      ? { authoritativeSource: "manual_reconciliation" as const }
      : {}),
  });
  return NextResponse.json({ promo: updated });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;
  const existing = await getPromo(auth.userId, id);
  if (!existing) return jsonError("not found", 404);
  await archivePromo(auth.userId, id);
  return NextResponse.json({ ok: true });
}
