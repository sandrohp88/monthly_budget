import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import { getPromo, listPromoPayments, replacePromoPayments } from "@/lib/repos";
import { promoPaymentBulkReplaceSchema } from "@/lib/validation";

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

  // Strict balance check: a manual schedule must add up to the remaining
  // principal exactly. The projection engine (projectPromoScheduleWithBalances)
  // uses the manual list verbatim — it doesn't auto-balance the last cycle —
  // so a schedule that under- or overshoots silently misprojects the cliff.
  // An empty list clears the manual override and reverts to auto-spread.
  if (data.payments.length > 0) {
    const sum = data.payments.reduce((s, p) => s + p.amountCents, 0);
    if (sum !== promo.remainingAmountCents) {
      const diff = promo.remainingAmountCents - sum;
      const direction = diff > 0 ? "short" : "over";
      return jsonError(
        `Schedule total ${sum} cents is ${direction} by ${Math.abs(diff)} cents — must equal remaining principal of ${promo.remainingAmountCents} cents.`,
        400,
      );
    }
  }

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
