import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import { getPromo, listPromoPayments, replacePromoPayments } from "@/lib/repos";
import { promoPaymentBulkReplaceSchema } from "@/lib/validation";
import { promoPaymentScheduleError } from "@/lib/credit-cards";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;
  const promo = await getPromo(auth.userId, id);
  if (!promo) return jsonError("promo not found", 404);
  const payments = await listPromoPayments(auth.userId, id);
  return NextResponse.json({ payments });
}

export async function PUT(req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;
  const promo = await getPromo(auth.userId, id);
  if (!promo) return jsonError("promo not found", 404);

  const data = await readJson(req, promoPaymentBulkReplaceSchema);
  if (data instanceof NextResponse) return data;

  // Empty clears the manual override. Non-empty schedules must cover the
  // issuer-reconciled remaining balance completely by the promo deadline.
  const scheduleError = promoPaymentScheduleError(promo, data.payments);
  if (scheduleError) return jsonError(scheduleError, 400);

  const payments = await replacePromoPayments(
    auth.userId,
    id,
    data.payments.map((p) => ({
      dueDate: p.dueDate,
      amountCents: p.amountCents,
      note: p.note ?? null,
    })),
  );
  return NextResponse.json({ payments });
}
