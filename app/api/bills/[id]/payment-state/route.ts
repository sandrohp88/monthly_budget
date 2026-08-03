import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import {
  deleteBillPaymentState,
  getBill,
  getSettings,
  upsertBillPaymentState,
} from "@/lib/repos";
import { todayIso } from "@/lib/dates";
import { billPaymentStateSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Record what the user says happened to one bill occurrence when the
 * transaction feed can't answer yet — see `bill_payment_states` in
 * lib/db/schema.ts. Idempotent per `(bill, dueDate)`.
 */
export async function PUT(req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const bill = await getBill(auth.userId, id);
  if (!bill) return jsonError("not found", 404);

  const data = await readJson(req, billPaymentStateSchema);
  if (data instanceof NextResponse) return data;

  // `markedDate` says when the money left. A future date would park a hold on
  // a day the projection has already walked past, so reject it outright
  // instead of quietly clamping and reporting something the user didn't say.
  const settings = await getSettings(auth.userId);
  const today = todayIso(settings?.timezone ?? "UTC");
  if (data.markedDate > today) {
    return jsonError("markedDate cannot be in the future", 400);
  }

  const state = await upsertBillPaymentState(auth.userId, id, {
    dueDate: data.dueDate,
    state: data.state,
    amountCents: data.amountCents ?? null,
    markedDate: data.markedDate,
    notes: data.notes ?? null,
  });
  return NextResponse.json({ state });
}

/** Take the claim back — the occurrence returns to whatever the evidence says. */
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

  await deleteBillPaymentState(auth.userId, id, dueDate);
  return NextResponse.json({ ok: true });
}
