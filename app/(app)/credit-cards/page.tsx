import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  listCreditCards,
  listPlaidAccounts,
  listPlaidItems,
  listPromosForCard,
  listStatements,
} from "@/lib/repos";
import { interestSavingCashDueCents, isStatementOpen } from "@/lib/credit-cards";
import { CreditCardsClient, type WalletCard } from "./credit-cards-client";

export const dynamic = "force-dynamic";

export default async function CreditCardsPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const [cards, accounts, items] = await Promise.all([
    listCreditCards(userId), // active only — the wallet shows cards in use
    listPlaidAccounts(userId),
    listPlaidItems(userId),
  ]);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const institutionByItemId = new Map(items.map((i) => [i.id, i.institutionName]));

  const data: WalletCard[] = await Promise.all(
    cards.map(async (card) => {
      const [statements, promos] = await Promise.all([
        listStatements(card.id),
        listPromosForCard(userId, card.id),
      ]);

      const account = card.plaidAccountId
        ? accountById.get(card.plaidAccountId)
        : undefined;

      const openStatements = statements.filter(isStatementOpen);
      // Due to avoid interest: the Interest Saving Balance when the card has
      // active 0% promos, the full statement cash due otherwise.
      const dueCents = openStatements.reduce(
        (s, x) => s + interestSavingCashDueCents(x, promos),
        0,
      );
      const dueDate =
        openStatements.map((s) => s.dueDate).sort((a, b) => a.localeCompare(b))[0] ?? null;

      const promoRemainingCents = promos
        .filter((p) => p.isActive && p.remainingAmountCents > 0)
        .reduce((s, p) => s + p.remainingAmountCents, 0);

      // Best-known balance: manual/synced card balance, then the linked
      // account's live balance, then known obligations (unpaid statements +
      // active promo principal) as a floor for manual cards.
      const balanceCents =
        card.currentBalanceCents ??
        account?.balanceCents ??
        (statements.length > 0 || promoRemainingCents > 0
          ? dueCents + promoRemainingCents
          : null);

      return {
        card,
        mask: account?.mask ?? null,
        institution: account ? (institutionByItemId.get(account.itemId) ?? null) : null,
        balanceCents,
        dueCents,
        dueDate,
      };
    }),
  );

  return <CreditCardsClient initialCards={data} />;
}
