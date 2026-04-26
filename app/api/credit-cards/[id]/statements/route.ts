import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import { createStatement, getCreditCard } from "@/lib/repos";
import { statementCreateSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const card = await getCreditCard(auth.userId, id);
  if (!card) return jsonError("card not found", 404);

  const data = await readJson(req, statementCreateSchema);
  if (data instanceof NextResponse) return data;
  if (data.dueDate < data.statementDate) {
    return jsonError("due date must be on or after statement date", 400);
  }

  const statement = await createStatement(card.id, {
    statementDate: data.statementDate,
    dueDate: data.dueDate,
    statementBalanceCents: data.statementBalanceCents,
    notes: data.notes ?? null,
    paidAmountCents: null,
    paidDate: null,
  });
  return NextResponse.json({ statement }, { status: 201 });
}
