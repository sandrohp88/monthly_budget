import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  getSettings,
  listCreditCards,
  listPlaidAccounts,
  listPlaidItems,
  listPromosForCard,
  listStatements,
} from "@/lib/repos";
import { interestSavingCashDueCents, isStatementOpen } from "@/lib/credit-cards";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import { buildProjection } from "@/lib/projection-server";
import { buildCardForecast, type CardForecast } from "@/lib/card-forecast";
import { cardDisplayName } from "@/lib/card-art";
import { CreditCardsClient, type WalletCard } from "./credit-cards-client";

export const dynamic = "force-dynamic";

export default async function CreditCardsPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const [cards, accounts, items, settings, projection] = await Promise.all([
    listCreditCards(userId), // active only — the wallet shows cards in use
    listPlaidAccounts(userId),
    listPlaidItems(userId),
    getSettings(userId),
    // Cached per request — the forecast reshapes the same projection the
    // ledger and calendar render, so the numbers can't drift apart.
    buildProjection(userId),
  ]);
  const timezone = settings?.timezone ?? DEFAULT_TIMEZONE;
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

  // Wallet display names (issuer-qualified) carry through to the forecast so a
  // card reads the same in both tabs.
  const cardNames = new Map(
    data.map((wc) => [wc.card.id, cardDisplayName(wc.card.name, wc.institution)] as const),
  );
  const forecast: CardForecast | null = projection
    ? buildCardForecast({
        rows: projection.rows,
        today: projection.today,
        cardNames,
        // The projection window overshoots its month count by a few days; only
        // emit buckets it fully covers so the last month isn't truncated.
        months: projection.projectionMonths,
      })
    : null;

  return <CreditCardsClient initialCards={data} timezone={timezone} forecast={forecast} />;
}
