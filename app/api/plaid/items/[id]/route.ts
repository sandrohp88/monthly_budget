import { NextResponse } from "next/server";
import { ensureUser, jsonError } from "@/lib/api";
import { getPlaidItem, deactivatePlaidItem } from "@/lib/repos";
import { revokePlaidItemAtPlaid } from "@/lib/plaid-revoke";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const item = await getPlaidItem(auth.userId, id);
  if (!item) return jsonError("Not found", 404);

  // Revoke the token at Plaid's end first; failure is non-fatal, we still
  // deactivate locally.
  await revokePlaidItemAtPlaid(item);

  await deactivatePlaidItem(auth.userId, id);
  return new NextResponse(null, { status: 204 });
}
