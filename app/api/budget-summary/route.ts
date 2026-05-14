import { NextResponse } from "next/server";
import { ensureUser, jsonError } from "@/lib/api";
import { computeCategoryUtilization } from "@/lib/repos";

export async function GET(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return jsonError("month query param required (YYYY-MM)", 400);
  }

  const utilization = await computeCategoryUtilization(auth.userId, month);
  return NextResponse.json({ month, utilization });
}
