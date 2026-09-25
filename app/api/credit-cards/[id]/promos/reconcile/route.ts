import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import {
  applyPromoReconcile,
  getCreditCard,
  getSettings,
  listPromosForCard,
} from "@/lib/repos";
import { planPromoReconcile } from "@/lib/paypal-promo-list";
import { planChaseFlexReconcile, type ChaseFlexPlanRow } from "@/lib/chase-flex-plan-list";
import { promoReconcileSchema } from "@/lib/validation";
import { DEFAULT_TIMEZONE, todayIso } from "@/lib/dates";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Apply a pasted issuer promo list to this card's promos. Two sources share
 * this endpoint:
 *
 *   - `paypal_promo_list` — PayPal "Promotional purchases" page. Matched by
 *     description (merchant names are unique).
 *   - `chase_flex_plan_list` — a Chase statement's "Qualified Promotional
 *     Financing" table / chase.com plan list. Matched by plan expiration date
 *     (statement rows all share one description), and rows additionally carry
 *     the original purchase total and the fixed plan payment.
 *
 * The list is authoritative: matched promos take its amounts and payoff dates,
 * unmatched rows become new promos, and (optionally) active promos missing
 * from the list are archived as paid off. Every touched row is stamped with
 * the source so sync never rewrites it.
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
  const today = todayIso(settings?.timezone ?? DEFAULT_TIMEZONE);

  const promos = await listPromosForCard(auth.userId, id, false);
  const source = data.source;
  const rows: ChaseFlexPlanRow[] = data.rows.map((r) => ({
    description: r.description,
    remainingCents: r.remainingCents,
    endDate: r.endDate,
    originalCents: r.originalCents ?? null,
    monthlyPaymentCents: r.monthlyPaymentCents ?? null,
  }));
  // Both planners pass the row objects through by reference, so the plan's
  // rows keep the (possibly null) Chase-only fields from the mapping above.
  const planned =
    source === "chase_flex_plan_list"
      ? planChaseFlexReconcile(promos, rows)
      : planPromoReconcile(promos, rows);
  const plan = {
    updates: planned.updates.map((u) => ({ promoId: u.promoId, row: u.row as ChaseFlexPlanRow })),
    creates: planned.creates as ChaseFlexPlanRow[],
    archives: planned.archives,
  };

  // Zero-balance rows carry no debt. Expired rows with a reported remainder
  // must stay visible because deferred interest may already have triggered.
  const creates = plan.creates.filter((row) => row.remainingCents > 0);
  const archiveIds = data.archiveMissing ? plan.archives.map((a) => a.promoId) : [];

  // One transaction: a failure part-way through used to leave the card half
  // reconciled against the pasted list (review 2026-09-24 C11).
  applyPromoReconcile(auth.userId, id, {
    updates: plan.updates.map(({ promoId, row }) => ({
      promoId,
      patch: {
        remainingAmountCents: row.remainingCents,
        endDate: row.endDate,
        // A past deadline does not prove the balance was paid. Keep any
        // issuer-reported remainder active until the issuer reports zero.
        isActive: row.remainingCents > 0,
        authoritativeSource: source,
        // Chase rows carry the issuer's own plan payment + purchase total —
        // adopt them when present, keep the existing values otherwise.
        ...(row.monthlyPaymentCents != null
          ? { monthlyPaymentCents: row.monthlyPaymentCents }
          : {}),
        ...(row.originalCents != null ? { originalAmountCents: row.originalCents } : {}),
      },
    })),
    creates: creates.map((row) => ({
      description: row.description,
      // The issuer's purchase total when the table carries it; the current
      // balance is the best available anchor otherwise.
      originalAmountCents: row.originalCents ?? row.remainingCents,
      remainingAmountCents: row.remainingCents,
      startDate: today,
      endDate: row.endDate,
      monthlyPaymentCents: row.monthlyPaymentCents ?? null,
      notes:
        source === "chase_flex_plan_list"
          ? "Created from pasted Chase flex-plan list"
          : "Created from pasted PayPal promo list",
      authoritativeSource: source,
      isActive: true,
    })),
    archiveIds,
  });

  return NextResponse.json({
    updated: plan.updates.length,
    created: creates.length,
    archived: archiveIds.length,
  });
}
