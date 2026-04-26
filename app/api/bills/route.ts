import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { billCreateSchema } from "@/lib/validation";
import { createBill, listBills } from "@/lib/repos";

export async function GET(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const url = new URL(req.url);
  const archived = url.searchParams.get("archived") === "true";
  const rows = await listBills(auth.userId, archived);
  return NextResponse.json({ bills: rows });
}

export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const data = await readJson(req, billCreateSchema);
  if (data instanceof NextResponse) return data;
  try {
    const created = await createBill(auth.userId, {
      name: data.name,
      category: data.category,
      amountCents: data.amountCents,
      frequency: data.frequency,
      dueDay: data.dueDay,
      dueMonth: data.dueMonth ?? null,
      autoPay: data.autoPay,
      notes: data.notes ?? null,
      isActive: true,
    });
    return NextResponse.json({ bill: created });
  } catch (e) {
    return jsonError((e as Error).message ?? "create failed");
  }
}
