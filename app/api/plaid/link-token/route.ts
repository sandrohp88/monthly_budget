import { NextResponse } from "next/server";
import { ensureUser, jsonError } from "@/lib/api";
import { createLinkToken } from "@/lib/plaid-sync";

export async function POST() {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  try {
    const linkToken = await createLinkToken(auth.userId);
    return NextResponse.json({ linkToken });
  } catch (err) {
    const detail =
      (err as { response?: { data?: unknown } })?.response?.data ??
      (err as Error).message;
    return jsonError(`Failed to create link token: ${JSON.stringify(detail)}`);
  }
}
