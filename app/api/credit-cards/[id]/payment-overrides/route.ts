import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import {
  applyCardPaymentOps,
  CardPaymentConflictError,
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

  // Same path as the calendar's batch endpoint, so cancelling a plan that a
  // bank transaction is linked to needs the same confirmation (`?unlink=1`).
  try {
    applyCardPaymentOps(auth.userId, [{ op: "delete", cardId: id, dueDate }], {
      unlinkAllocations: url.searchParams.get("unlink") === "1",
    });
  } catch (e) {
    if (e instanceof CardPaymentConflictError && e.code) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
    }
    throw e;
  }
  return NextResponse.json({ ok: true });
}
