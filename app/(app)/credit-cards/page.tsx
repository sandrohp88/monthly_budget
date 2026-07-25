import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  getSettings,
  listCardTransactionsInRange,
  listCreditCards,
  listPlaidAccounts,
  listPlaidItems,
  listPromosForCard,
  listStatements,
} from "@/lib/repos";
import {
  currentCycleWindow,
  interestSavingCashDueCents,
  isStatementOpen,
} from "@/lib/credit-cards";
import { buildCardSpending, type CardSpendingSummary } from "@/lib/card-spending";
import { DEFAULT_TIMEZONE, todayIso } from "@/lib/dates";
import { cardDisplayName } from "@/lib/card-art";
import { CreditCardsClient, type WalletCard } from "./credit-cards-client";

export const dynamic = "force-dynamic";

export default async function CreditCardsPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const [cards, accounts, items, settings] = await Promise.all([
    listCreditCards(userId), // active only — the wallet shows cards in use
    listPlaidAccounts(userId),
    listPlaidItems(userId),
    getSettings(userId),
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

  // Issuer-qualified display names, so a card reads the same in the wallet
  // grid and the spending list.
  const cardNames = new Map(
    data.map((wc) => [wc.card.id, cardDisplayName(wc.card.name, wc.institution)] as const),
  );

  // ── Current-cycle spending, from real posted transactions ─────────────────
  // Each card's open cycle starts the day after its last statement closed, so
  // one query spanning the earliest window start covers every card.
  const today = todayIso(timezone);
  const spendingCards = data.map((wc) => ({
    cardId: wc.card.id,
    cardName: cardNames.get(wc.card.id) ?? wc.card.name,
    accountId: wc.card.plaidAccountId ?? null,
    balanceCents: wc.balanceCents,
    creditLimitCents:
      wc.card.creditLimitCents ??
      (wc.card.plaidAccountId
        ? (accountById.get(wc.card.plaidAccountId)?.limitCents ?? null)
        : null),
    window: currentCycleWindow(wc.card, today),
  }));
  const linkedAccountIds = spendingCards
    .map((c) => c.accountId)
    .filter((id): id is string => id != null);
  const earliestWindowStart = spendingCards
    .map((c) => c.window.start)
    .sort((a, b) => a.localeCompare(b))[0];
  const transactions =
    linkedAccountIds.length > 0 && earliestWindowStart
      ? await listCardTransactionsInRange(userId, linkedAccountIds, earliestWindowStart, today)
      : [];
  const spending: CardSpendingSummary = buildCardSpending({
    cards: spendingCards,
    transactions,
    today,
  });

  return <CreditCardsClient initialCards={data} timezone={timezone} spending={spending} />;
}
