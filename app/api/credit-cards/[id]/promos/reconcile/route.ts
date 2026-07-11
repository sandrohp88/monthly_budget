import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import {
  archivePromo,
  createPromo,
  getCreditCard,
  getSettings,
  listPromosForCard,
  updatePromo,
} from "@/lib/repos";
import { planPromoReconcile } from "@/lib/paypal-promo-list";
import { promoReconcileSchema } from "@/lib/validation";
import { todayIso } from "@/lib/dates";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Apply a pasted issuer promo list (PayPal "Promotional purchases") to this
 * card's promos. The list is authoritative: matched promos take its amounts
 * and payoff dates, unmatched rows become new promos, and (optionally) active
 * promos missing from the list are archived as paid off. Every touched row is
 * stamped `authoritativeSource = paypal_promo_list` so sync never rewrites it.
 */
export async function POST(req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const card = await getCreditCard(auth.userId, id);
  if (!card) return jsonError("card not found", 404);

  const data = await readJson(req, promoReconcileSchema);
  if (data instanceof NextResponse) return data;

  const settings = await getSettings(auth.userId);
  const today = todayIso(settings?.timezone);

  const promos = await listPromosForCard(auth.userId, id, false);
  const plan = planPromoReconcile(promos, data.rows);

  for (const { promoId, row } of plan.updates) {
    await updatePromo(auth.userId, promoId, {
      remainingAmountCents: row.remainingCents,
      endDate: row.endDate,
      // A past deadline does not prove the balance was paid. Keep any
      // issuer-reported remainder active until PayPal reports zero/removes it.
      isActive: row.remainingCents > 0,
      authoritativeSource: "paypal_promo_list",
    });
  }

  let created = 0;
  for (const row of plan.creates) {
    // Zero-balance rows carry no debt. Expired rows with a reported remainder
    // must stay visible because deferred interest may already have triggered.
    if (row.remainingCents <= 0) continue;
    await createPromo(auth.userId, id, {
      description: row.description,
      // The list shows the current balance, not the original purchase —
      // remaining is the best available anchor for both.
      originalAmountCents: row.remainingCents,
      remainingAmountCents: row.remainingCents,
      startDate: today,
      endDate: row.endDate,
      monthlyPaymentCents: null,
      notes: "Created from pasted PayPal promo list",
      authoritativeSource: "paypal_promo_list",
      isActive: true,
    });
    created++;
  }

  let archived = 0;
  if (data.archiveMissing) {
    for (const a of plan.archives) {
      await archivePromo(auth.userId, a.promoId);
      archived++;
    }
  }

  return NextResponse.json({
    updated: plan.updates.length,
    created,
    archived,
  });
}
