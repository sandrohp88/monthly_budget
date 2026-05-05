import { NextResponse } from "next/server";
import { ensureUser, jsonError } from "@/lib/api";
import { listCreditCards, listPlaidDrafts, listPlaidAccounts } from "@/lib/repos";
import { detectPromoPayoffDate } from "@/lib/plaid-promo-parser";
import { isPayPalCreditAccount, isPayPalWalletAccount } from "@/lib/paypal-special-financing";
import type { PlaidTransactionDraftRow, PlaidAccountRow } from "@/lib/db/schema";

export type DraftWithAccount = PlaidTransactionDraftRow & {
  accountName: string;
  accountMask: string | null;
  accountType: string | null;
  accountSubtype: string | null;
  linkedCreditCardId: string | null;
  linkedCreditCardName: string | null;
  promoPayoffDate: string | null;
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
    const [drafts, accounts, cards] = await Promise.all([
      listPlaidDrafts(auth.userId, statusParam as StatusParam),
      listPlaidAccounts(auth.userId),
      listCreditCards(auth.userId, false),
    ]);

    const accountMap = new Map<string, PlaidAccountRow>(accounts.map((a) => [a.id, a]));
    const cardMap = new Map(
      cards
        .filter((c) => c.plaidAccountId)
        .map((c) => [c.plaidAccountId!, { id: c.id, name: c.name }]),
    );
    const paypalCreditCardByItem = new Map(
      accounts
        .filter(isPayPalCreditAccount)
        .map((account) => {
          const linked = cardMap.get(account.id);
          return linked ? [account.itemId, linked] as const : null;
        })
        .filter((entry): entry is [string, { id: string; name: string }] => entry !== null),
    );

    const enriched: DraftWithAccount[] = drafts.map((d) => {
      const account = accountMap.get(d.accountId);
      const directCard = cardMap.get(d.accountId);
      const pairedPayPalCard =
        account && isPayPalWalletAccount(account)
          ? paypalCreditCardByItem.get(account.itemId)
          : undefined;
      const linkedCard = directCard ?? pairedPayPalCard;
      return {
        ...d,
        accountName: account?.name ?? "Unknown Account",
        accountMask: account?.mask ?? null,
        accountType: account?.type ?? null,
        accountSubtype: account?.subtype ?? null,
        linkedCreditCardId: linkedCard?.id ?? null,
        linkedCreditCardName: linkedCard?.name ?? null,
        promoPayoffDate: detectPromoPayoffDate([
          d.originalDescription,
          d.description,
          d.merchantName,
        ]),
      };
    });

    return NextResponse.json({ drafts: enriched });
  } catch (err) {
    return jsonError(`Failed to list drafts: ${(err as Error).message}`);
  }
}
