import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import {
  archiveCreditCard,
  getCardOpenObligation,
  getCreditCard,
  updateCreditCard,
} from "@/lib/repos";
import { creditCardUpdateSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Archiving a card takes it out of the wallet AND out of the projection: due
 * markers are raised for active cards only, so anything the card still owes
 * stops being tracked the moment it's archived. That's the right default (an
 * archived card you can't open shouldn't nag you forever), but it must not
 * happen silently on a card mid-obligation.
 *
 * So: 409 with the outstanding total unless the caller passes `?force=1`,
 * which the UI sends after showing the amount and getting a second confirm.
 * Never a hard block — archiving stays the user's call.
 */
async function openObligationGuard(userId: string, cardId: string, req: Request) {
  if (new URL(req.url).searchParams.get("force") === "1") return null;
  const obligation = await getCardOpenObligation(userId, cardId);
  if (obligation.cents <= 0) return null;
  return NextResponse.json(
    { error: "card has unpaid statements", openObligation: obligation },
    { status: 409 },
  );
}

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const existing = await getCreditCard(auth.userId, id);
  if (!existing) return jsonError("not found", 404);

  const data = await readJson(req, creditCardUpdateSchema);
  if (data instanceof NextResponse) return data;

  // PATCH can archive too (`isActive: false`) — same guard as DELETE, so the
  // check can't be walked around by picking the other verb.
  if (data.isActive === false && existing.isActive) {
    const blocked = await openObligationGuard(auth.userId, id, req);
    if (blocked) return blocked;
  }

  const nextCycleMode = data.statementCycleMode ?? existing.statementCycleMode;
  const nextStatementDay = data.statementDay ?? existing.statementDay;
  const nextDueDay = data.dueDay ?? existing.dueDay;
  const nextAnchorDate =
    data.statementCycleAnchorDate !== undefined
      ? data.statementCycleAnchorDate
      : existing.statementCycleAnchorDate;

  if (nextCycleMode === "calendar_day" && nextDueDay === nextStatementDay) {
    return jsonError("statement day and due day must differ", 400);
  }
  if (nextCycleMode === "interval_days" && !nextAnchorDate) {
    return jsonError("statement anchor date is required for interval cycles", 400);
  }

  const updated = await updateCreditCard(auth.userId, id, {
    ...(data.name !== undefined ? { name: data.name.trim() } : {}),
    ...(data.statementDay !== undefined ? { statementDay: data.statementDay } : {}),
    ...(data.statementCycleMode !== undefined ? { statementCycleMode: data.statementCycleMode } : {}),
    ...(data.statementCycleAnchorDate !== undefined
      ? { statementCycleAnchorDate: data.statementCycleAnchorDate }
      : {}),
    ...(data.statementCycleIntervalDays !== undefined
      ? { statementCycleIntervalDays: data.statementCycleIntervalDays }
      : {}),
    ...(data.dueDay !== undefined ? { dueDay: data.dueDay } : {}),
    ...(data.currentBalanceCents !== undefined
      ? { currentBalanceCents: data.currentBalanceCents }
      : {}),
    ...(data.creditLimitCents !== undefined
      ? { creditLimitCents: data.creditLimitCents }
      : {}),
    ...(data.autoPay !== undefined ? { autoPay: data.autoPay } : {}),
    ...(data.notes !== undefined ? { notes: data.notes ?? null } : {}),
    ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
  });
  return NextResponse.json({ card: updated });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;
  const existing = await getCreditCard(auth.userId, id);
  if (!existing) return jsonError("not found", 404);
  if (existing.isActive) {
    const blocked = await openObligationGuard(auth.userId, id, req);
    if (blocked) return blocked;
  }
  await archiveCreditCard(auth.userId, id);
  return NextResponse.json({ ok: true });
}
