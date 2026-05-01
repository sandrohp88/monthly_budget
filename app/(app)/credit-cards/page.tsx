import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listBills, listCreditCards, listStatements } from "@/lib/repos";
import { estimateCurrentCycle } from "@/lib/credit-cards";
import { todayIso } from "@/lib/dates";
import { CreditCardsClient } from "./credit-cards-client";

export const dynamic = "force-dynamic";

export default async function CreditCardsPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const [cards, allBills] = await Promise.all([
    listCreditCards(userId, true),
    listBills(userId, false), // active only — archived bills don't predict charges
  ]);

  const today = todayIso();

  // For each card, gather its linked active bills and project the open cycle.
  const data = await Promise.all(
    cards.map(async (card) => {
      const linkedBills = allBills.filter((b) => b.paidViaCardId === card.id);
      const estimate = card.isActive
        ? estimateCurrentCycle(card, linkedBills, today)
        : null;
      return {
        card,
        statements: await listStatements(card.id),
        estimate,
        linkedBillCount: linkedBills.length,
      };
    }),
  );

  return <CreditCardsClient initialCards={data} />;
}
