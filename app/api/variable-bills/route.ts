import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { variableBillCreateSchema } from "@/lib/validation";
import { createVariableBill, listVariableBills } from "@/lib/repos";

export async function GET(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const url = new URL(req.url);
  const archived = url.searchParams.get("archived") === "true";
  const rows = await listVariableBills(auth.userId, archived);
  return NextResponse.json({ variableBills: rows });
}

export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const data = await readJson(req, variableBillCreateSchema);
  if (data instanceof NextResponse) return data;
  try {
    const created = await createVariableBill(auth.userId, {
      name: data.name,
      category: data.category,
      amountCents: data.amountCents,
      intervalMonths: data.intervalMonths,
      anchorDate: data.anchorDate,
      notes: data.notes ?? null,
      isActive: true,
      cardIds: data.cardIds,
    });
    return NextResponse.json({ variableBill: created });
  } catch (e) {
    return jsonError((e as Error).message ?? "create failed");
  }
}
