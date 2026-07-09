import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import {
  applyPromoChunksForPaidStatement,
  deleteStatement,
  getStatement,
  updateStatement,
} from "@/lib/repos";
import { statementUpdateSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const existing = await getStatement(auth.userId, id);
  if (!existing) return jsonError("not found", 404);

  const data = await readJson(req, statementUpdateSchema);
  if (data instanceof NextResponse) return data;

  const statement = await updateStatement(id, {
    ...(data.statementDate !== undefined ? { statementDate: data.statementDate } : {}),
    ...(data.dueDate !== undefined ? { dueDate: data.dueDate } : {}),
    ...(data.statementBalanceCents !== undefined
      ? { statementBalanceCents: data.statementBalanceCents }
      : {}),
    ...(data.minimumPaymentCents !== undefined
      ? { minimumPaymentCents: data.minimumPaymentCents }
      : {}),
    ...(data.paidAmountCents !== undefined ? { paidAmountCents: data.paidAmountCents } : {}),
    // Un-paying releases the draft that auto-settled this statement — without
    // this, the re-opened statement could never auto-reconcile again (the
    // settle-once gate would see its own draft as already consumed).
    ...(data.paidAmountCents === null ? { settledByDraftId: null } : {}),
    ...(data.paidDate !== undefined ? { paidDate: data.paidDate } : {}),
    ...(data.notes !== undefined ? { notes: data.notes ?? null } : {}),
  });

  // Auto-decrement promo remainings ONLY on the unpaid → paid transition with
  // a positive payment. Re-saving an already-paid statement would otherwise
  // double-decrement, and a $0 mark-as-paid would silently shrink promo
  // principal even though no cash moved.
  const wasUnpaid = existing.paidAmountCents == null;
  const isNowPaidWithCash = (statement?.paidAmountCents ?? 0) > 0;
  if (wasUnpaid && isNowPaidWithCash) {
    await applyPromoChunksForPaidStatement(
      auth.userId,
      existing.cardId,
      existing.statementDate,
    );
  }

  return NextResponse.json({ statement });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const existing = await getStatement(auth.userId, id);
  if (!existing) return jsonError("not found", 404);

  await deleteStatement(id);
  return NextResponse.json({ ok: true });
}
