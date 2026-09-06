import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { buildProjection } from "@/lib/projection-server";
import {
  listBills,
  listCategories,
  listCreditCards,
  listCreditCardPaymentOverridesForUser,
  listExtras,
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

  const [drafts, accounts, cards, categories, bills, extras, projection, cardPlans] =
    await Promise.all([
      listPlaidDrafts(userId, "approved"),
      listPlaidAccounts(userId),
      listCreditCards(userId, false),
      listCategories(userId),
      listBills(userId, false),
      listExtras(userId),
      // Cached per request (the layout already builds it) — reused here for the
      // bill-reconciliation matches so the rows can show "this paid bill X".
      buildProjection(userId),
      listCreditCardPaymentOverridesForUser(userId),
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
        return linked ? ([account.itemId, linked] as const) : null;
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
      billMatches={projection?.billMatchesByDraftId ?? {}}
      // The split dialog enumerates each bill's occurrences client-side, so it
      // needs the recurrence shape — not just a name.
      bills={bills.map((b) => ({
        id: b.id,
        name: b.name,
        amountCents: b.amountCents,
        intervalMonths: b.intervalMonths,
        anchorDate: b.anchorDate,
      }))}
      plannedCardPayments={cardPlans
        .filter((p) => p.amountCents > 0 && cards.some((c) => c.id === p.cardId))
        .map((p) => ({
          id: p.cardId,
          date: p.dueDate,
          amountCents: p.amountCents,
          description: `${cards.find((c) => c.id === p.cardId)!.name} planned payment`,
        }))}
      extras={extras.map((e) => ({
        id: e.id,
        description: e.description,
        date: e.date,
        amountCents: e.amountCents,
      }))}
    />
  );
}
