import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import { plaidAccountUpdateSchema } from "@/lib/validation";
import { updatePlaidAccount } from "@/lib/repos";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  const body = await readJson(req, plaidAccountUpdateSchema);
  if (body instanceof NextResponse) return body;

  const account = await updatePlaidAccount(auth.userId, id, body);
  if (!account) return jsonError("Not found", 404);

  return NextResponse.json({ account });
}
