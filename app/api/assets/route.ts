import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { assetCreateSchema } from "@/lib/validation";
import { createAsset, listAssets } from "@/lib/repos";

export async function GET() {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ assets: await listAssets(auth.userId) });
}

export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const data = await readJson(req, assetCreateSchema);
  if (data instanceof NextResponse) return data;
  try {
    const created = await createAsset(auth.userId, {
      name: data.name,
      valueCents: data.valueCents,
      category: data.category,
      notes: data.notes ?? null,
      asOfDate: data.asOfDate,
    });
    return NextResponse.json({ asset: created });
  } catch (e) {
    return jsonError((e as Error).message ?? "create failed");
  }
}
