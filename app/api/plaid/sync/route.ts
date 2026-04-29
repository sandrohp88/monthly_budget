import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import { plaidSyncSchema } from "@/lib/validation";
import { syncPlaidTransactions } from "@/lib/plaid-sync";

export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const body = await readJson(req, plaidSyncSchema);
  if (body instanceof NextResponse) return body;

  try {
    const result = await syncPlaidTransactions(auth.userId, body.itemId);
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(`Sync failed: ${(err as Error).message}`);
  }
}
