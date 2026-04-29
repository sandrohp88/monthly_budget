import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  listPlaidItems,
  listPlaidAccountsByItem,
  listPlaidDrafts,
  listCategories,
  listCreditCards,
  listStatements,
} from "@/lib/repos";
import { AccountsClient } from "./accounts-client";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const [items, pendingDrafts, categories, cards] = await Promise.all([
    listPlaidItems(userId),
    listPlaidDrafts(userId, "pending_review"),
    listCategories(userId),
    listCreditCards(userId, false),
  ]);

  const itemsWithAccounts = await Promise.all(
    items.map(async (item) => ({
      ...item,
      accounts: await listPlaidAccountsByItem(item.id),
    })),
  );

  const cardsWithStatements = await Promise.all(
    cards.map(async (card) => ({ card, statements: await listStatements(card.id) })),
  );

  const categoryNames = categories
    .filter((c) => c.kind === "expense")
    .map((c) => c.name);

  return (
    <AccountsClient
      initialItems={itemsWithAccounts}
      initialPendingCount={pendingDrafts.length}
      initialCards={cardsWithStatements}
      categoryNames={categoryNames}
    />
  );
}
