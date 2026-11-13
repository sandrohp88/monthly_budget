import { requirePageUser } from "@/lib/auth";
import {
  getSettings,
  listPlaidItems,
  listPlaidAccountsByItem,
  listCreditCards,
  listPromosForCard,
  listStatements,
} from "@/lib/repos";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import { AccountsClient } from "./accounts-client";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const { id: userId } = await requirePageUser();

  const [items, cards, settings] = await Promise.all([
    listPlaidItems(userId),
    listCreditCards(userId, false),
    getSettings(userId),
  ]);

  const itemsWithAccounts = await Promise.all(
    items.map(async (item) => ({
      ...item,
      accounts: await listPlaidAccountsByItem(item.id),
    })),
  );

  const cardsWithStatements = await Promise.all(
    cards.map(async (card) => {
      const [statements, promos] = await Promise.all([
        listStatements(card.id),
        listPromosForCard(userId, card.id),
      ]);
      return { card, statements, promos };
    }),
  );

  return (
    <AccountsClient
      initialItems={itemsWithAccounts}
      initialCards={cardsWithStatements}
      // Health is judged against the server's clock at render time, so the
      // server and client render the same status. router.refresh() after a
      // sync re-renders with a new value.
      nowMs={Date.now()}
      timeZone={settings?.timezone ?? DEFAULT_TIMEZONE}
    />
  );
}
