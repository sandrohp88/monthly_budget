import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import { createPromo, getCreditCard, listPromosForCard } from "@/lib/repos";
import { promoCreateSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const card = await getCreditCard(auth.userId, id);
  if (!card) return jsonError("card not found", 404);

  const url = new URL(req.url);
  const includeArchived = url.searchParams.get("archived") === "1";
  const promos = await listPromosForCard(auth.userId, id, includeArchived);
  return NextResponse.json({ promos });
}

export async function POST(req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const card = await getCreditCard(auth.userId, id);
  if (!card) return jsonError("card not found", 404);

  const data = await readJson(req, promoCreateSchema);
  if (data instanceof NextResponse) return data;

  const promo = await createPromo(auth.userId, id, {
    description: data.description.trim(),
    originalAmountCents: data.originalAmountCents,
    remainingAmountCents: data.remainingAmountCents ?? data.originalAmountCents,
    startDate: data.startDate,
    endDate: data.endDate,
    monthlyPaymentCents: data.monthlyPaymentCents ?? null,
    notes: data.notes ?? null,
    authoritativeSource: data.authoritativeSource ?? "manual_reconciliation",
  });
  return NextResponse.json({ promo }, { status: 201 });
}
