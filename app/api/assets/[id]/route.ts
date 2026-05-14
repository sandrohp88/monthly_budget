import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { assetUpdateSchema } from "@/lib/validation";
import { archiveAsset, getAsset, updateAsset } from "@/lib/repos";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const data = await readJson(req, assetUpdateSchema);
  if (data instanceof NextResponse) return data;
  try {
    const updated = await updateAsset(auth.userId, id, data);
    if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ asset: updated });
  } catch (e) {
    return jsonError((e as Error).message ?? "update failed");
  }
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const existing = await getAsset(auth.userId, id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  await archiveAsset(auth.userId, id);
  return NextResponse.json({ ok: true });
}
