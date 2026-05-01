import { NextResponse } from "next/server";
import { ensureUser, jsonError } from "@/lib/api";
import { listPlaidDrafts, listPlaidAccounts } from "@/lib/repos";
import type { PlaidTransactionDraftRow, PlaidAccountRow } from "@/lib/db/schema";

export type DraftWithAccount = PlaidTransactionDraftRow & {
  accountName: string;
  accountMask: string | null;
};

export async function GET(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status") ?? "pending_review";
  const validStatuses = ["pending_review", "approved", "dismissed", "all"] as const;
  type StatusParam = (typeof validStatuses)[number];
  if (!validStatuses.includes(statusParam as StatusParam)) {
    return jsonError("Invalid status parameter", 400);
  }

  try {
    const [drafts, accounts] = await Promise.all([
      listPlaidDrafts(auth.userId, statusParam as StatusParam),
      listPlaidAccounts(auth.userId),
    ]);

    const accountMap = new Map<string, PlaidAccountRow>(accounts.map((a) => [a.id, a]));

    const enriched: DraftWithAccount[] = drafts.map((d) => ({
      ...d,
      accountName: accountMap.get(d.accountId)?.name ?? "Unknown Account",
      accountMask: accountMap.get(d.accountId)?.mask ?? null,
    }));

    return NextResponse.json({ drafts: enriched });
  } catch (err) {
    return jsonError(`Failed to list drafts: ${(err as Error).message}`);
  }
}
