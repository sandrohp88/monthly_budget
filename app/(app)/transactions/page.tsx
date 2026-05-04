import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  listCategories,
  listCreditCards,
  listPlaidAccounts,
  listPlaidDrafts,
} from "@/lib/repos";
import { detectPromoPayoffDate } from "@/lib/plaid-promo-parser";
import type { DraftWithAccount } from "@/app/api/plaid/drafts/route";
import { TransactionsClient } from "./transactions-client";

export const dynamic = "force-dynamic";

export default async function TransactionsPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const [drafts, accounts, cards, categories] = await Promise.all([
    listPlaidDrafts(userId, "approved"),
    listPlaidAccounts(userId),
    listCreditCards(userId, false),
    listCategories(userId),
  ]);

  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const cardMap = new Map(
    cards
      .filter((c) => c.plaidAccountId)
      .map((c) => [c.plaidAccountId!, { id: c.id, name: c.name }]),
  );

  const transactions: DraftWithAccount[] = drafts.map((d) => ({
    ...d,
    accountName: accountMap.get(d.accountId)?.name ?? "Unknown Account",
    accountMask: accountMap.get(d.accountId)?.mask ?? null,
    accountType: accountMap.get(d.accountId)?.type ?? null,
    accountSubtype: accountMap.get(d.accountId)?.subtype ?? null,
    linkedCreditCardId: cardMap.get(d.accountId)?.id ?? null,
    linkedCreditCardName: cardMap.get(d.accountId)?.name ?? null,
    promoPayoffDate: detectPromoPayoffDate([
      d.originalDescription,
      d.description,
      d.merchantName,
    ]),
  }));

  return (
    <TransactionsClient
      initialTransactions={transactions}
      categoryNames={categories.filter((c) => c.kind === "expense").map((c) => c.name)}
    />
  );
}
