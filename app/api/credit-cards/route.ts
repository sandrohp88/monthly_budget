import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import { createCreditCard, listCreditCards, listStatements } from "@/lib/repos";
import { creditCardCreateSchema } from "@/lib/validation";

export async function GET(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const includeArchived = url.searchParams.get("archived") === "1";
  const cards = await listCreditCards(auth.userId, includeArchived);

  // Load statements for each card so the client can show current/upcoming.
  const withStatements = await Promise.all(
    cards.map(async (card) => ({ card, statements: await listStatements(card.id) })),
  );
  return NextResponse.json({ cards: withStatements });
}

export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const data = await readJson(req, creditCardCreateSchema);
  if (data instanceof NextResponse) return data;

  if (data.dueDay === data.statementDay) {
    return jsonError("statement day and due day must differ", 400);
  }
  const card = await createCreditCard(auth.userId, {
    name: data.name.trim(),
    statementDay: data.statementDay,
    dueDay: data.dueDay,
    autoPay: data.autoPay,
    notes: data.notes ?? null,
  });
  return NextResponse.json({ card }, { status: 201 });
}
