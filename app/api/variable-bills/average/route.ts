import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { todayIso } from "@/lib/dates";
import { estimateVariableBillAverage, getSettings } from "@/lib/repos";
import { variableBillAverageSchema } from "@/lib/validation";

export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const data = await readJson(req, variableBillAverageSchema);
  if (data instanceof NextResponse) return data;
  try {
    const settings = await getSettings(auth.userId);
    const average = await estimateVariableBillAverage(auth.userId, {
      name: data.name,
      category: data.category,
      cardIds: data.cardIds,
      lookbackMonths: data.lookbackMonths ?? 6,
      asOfIso: todayIso(settings?.timezone),
    });
    return NextResponse.json({ average });
  } catch (e) {
    return jsonError((e as Error).message ?? "average failed");
  }
}
