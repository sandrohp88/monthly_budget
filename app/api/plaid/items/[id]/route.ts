import { NextResponse } from "next/server";
import { ensureUser, jsonError } from "@/lib/api";
import { getPlaidItem, deactivatePlaidItem } from "@/lib/repos";
import { getPlaidClient } from "@/lib/plaid-client";
import { decryptToken } from "@/lib/plaid-crypto";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const item = await getPlaidItem(auth.userId, id);
  if (!item) return jsonError("Not found", 404);

  try {
    // Revoke the token at Plaid's end first.
    const plaid = getPlaidClient();
    const accessToken = decryptToken(
      item.accessTokenEnc,
      item.accessTokenIv,
      item.accessTokenTag,
    );
    await plaid.itemRemove({ access_token: accessToken });
  } catch {
    // itemRemove failure is non-fatal — we still deactivate locally.
  }

  await deactivatePlaidItem(auth.userId, id);
  return new NextResponse(null, { status: 204 });
}
