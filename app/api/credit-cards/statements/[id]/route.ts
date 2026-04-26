import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import { deleteStatement, getStatement, updateStatement } from "@/lib/repos";
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
    ...(data.paidAmountCents !== undefined ? { paidAmountCents: data.paidAmountCents } : {}),
    ...(data.paidDate !== undefined ? { paidDate: data.paidDate } : {}),
    ...(data.notes !== undefined ? { notes: data.notes ?? null } : {}),
  });
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
