import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  listCategories,
  listCreditCards,
  listPlaidAccounts,
  listPlaidDrafts,
} from "@/lib/repos";
import { detectPromoPayoffDate } from "@/lib/plaid-promo-parser";
import { isPayPalCreditAccount, isPayPalWalletAccount } from "@/lib/paypal-special-financing";
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
  const paypalCreditCardByItem = new Map(
    accounts
      .filter(isPayPalCreditAccount)
      .map((account) => {
        const linked = cardMap.get(account.id);
        return linked ? [account.itemId, linked] as const : null;
      })
      .filter((entry): entry is [string, { id: string; name: string }] => entry !== null),
  );

  const transactions: DraftWithAccount[] = drafts.map((d) => {
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

  return (
    <TransactionsClient
      initialTransactions={transactions}
      categoryNames={categories.filter((c) => c.kind === "expense").map((c) => c.name)}
    />
  );
}
