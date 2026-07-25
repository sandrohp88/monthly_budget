import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import { archiveCreditCard, getCreditCard, updateCreditCard } from "@/lib/repos";
import { creditCardUpdateSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const existing = await getCreditCard(auth.userId, id);
  if (!existing) return jsonError("not found", 404);

  const data = await readJson(req, creditCardUpdateSchema);
  if (data instanceof NextResponse) return data;

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

export async function DELETE(_req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;
  const existing = await getCreditCard(auth.userId, id);
  if (!existing) return jsonError("not found", 404);
  await archiveCreditCard(auth.userId, id);
  return NextResponse.json({ ok: true });
}
