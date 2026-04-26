import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { settingsUpdateSchema } from "@/lib/validation";
import { getSettings, updateSettings } from "@/lib/repos";

export async function GET() {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const settings = await getSettings(auth.userId);
  if (!settings) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ settings });
}

export async function PATCH(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const data = await readJson(req, settingsUpdateSchema);
  if (data instanceof NextResponse) return data;
  try {
    const updated = await updateSettings(auth.userId, data);
    return NextResponse.json({ settings: updated });
  } catch (e) {
    return jsonError((e as Error).message ?? "update failed");
  }
}
