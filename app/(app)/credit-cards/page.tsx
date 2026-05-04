import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listBills, listCreditCards, listExtras, listPromosForCard, listStatements } from "@/lib/repos";
import { estimateCurrentCycle } from "@/lib/credit-cards";
import { todayIso } from "@/lib/dates";
import { CreditCardsClient } from "./credit-cards-client";

export const dynamic = "force-dynamic";

export default async function CreditCardsPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const [cards, allBills, allExtras] = await Promise.all([
    listCreditCards(userId, true),
    listBills(userId, false), // active only — archived bills don't predict charges
    listExtras(userId),
  ]);

  const today = todayIso();

  // For each card, gather its linked active bills, project the open cycle, and
  // load active + archived promos so the UI can show history under a toggle.
  const data = await Promise.all(
    cards.map(async (card) => {
      const linkedBills = allBills.filter((b) => b.paidViaCardId === card.id);
      const linkedExtras = allExtras.filter((e) => e.paidViaCardId === card.id);
      const estimate = card.isActive
        ? estimateCurrentCycle(card, linkedBills, today, linkedExtras)
        : null;
      const [statements, promos] = await Promise.all([
        listStatements(card.id),
        listPromosForCard(userId, card.id, true),
      ]);
      return {
        card,
        statements,
        estimate,
        linkedBillCount: linkedBills.length + linkedExtras.length,
        promos,
      };
    }),
  );

  return <CreditCardsClient initialCards={data} />;
}
