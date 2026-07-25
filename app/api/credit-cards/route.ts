import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import { createCreditCard, listCreditCards, listPromosForCard, listStatements } from "@/lib/repos";
import { creditCardCreateSchema } from "@/lib/validation";

export async function GET(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const includeArchived = url.searchParams.get("archived") === "1";
  const cards = await listCreditCards(auth.userId, includeArchived);

  // Load statements + active promos for each card so the client can show
  // current/upcoming dues as the interest-saving amount.
  const withStatements = await Promise.all(
    cards.map(async (card) => {
      const [statements, promos] = await Promise.all([
        listStatements(card.id),
        listPromosForCard(auth.userId, card.id),
      ]);
      return { card, statements, promos };
    }),
  );
  return NextResponse.json({ cards: withStatements });
}

export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const data = await readJson(req, creditCardCreateSchema);
  if (data instanceof NextResponse) return data;

  if (data.statementCycleMode === "calendar_day" && data.dueDay === data.statementDay) {
    return jsonError("statement day and due day must differ", 400);
  }
  const card = await createCreditCard(auth.userId, {
    name: data.name.trim(),
    statementDay: data.statementDay,
    statementCycleMode: data.statementCycleMode,
    statementCycleAnchorDate: data.statementCycleMode === "interval_days" ? data.statementCycleAnchorDate! : null,
    statementCycleIntervalDays: data.statementCycleIntervalDays,
    dueDay: data.dueDay,
    currentBalanceCents: data.currentBalanceCents ?? null,
    creditLimitCents: data.creditLimitCents ?? null,
    autoPay: data.autoPay,
    notes: data.notes ?? null,
  });
  return NextResponse.json({ card }, { status: 201 });
}
