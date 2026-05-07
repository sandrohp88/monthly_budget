import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  listAllPromoPayments,
  listBills,
  listCreditCards,
  listExtras,
  listPromosForCard,
  listStatements,
  listVariableBills,
} from "@/lib/repos";
import { estimateCurrentCycle } from "@/lib/credit-cards";
import { todayIso } from "@/lib/dates";
import { projectVariableBillCardCharges } from "@/lib/variable-bills";
import { CreditCardsClient } from "./credit-cards-client";

export const dynamic = "force-dynamic";

export default async function CreditCardsPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const [cards, allBills, allExtras, allPromoPayments, variableBills] = await Promise.all([
    listCreditCards(userId, true),
    listBills(userId, false), // active only — archived bills don't predict charges
    listExtras(userId),
    listAllPromoPayments(userId),
    listVariableBills(userId, false),
  ]);

  const paymentsByPromoId: Record<
    string,
    Array<{ id: string; dueDate: string; amountCents: number; note: string | null }>
  > = {};
  for (const pp of allPromoPayments) {
    const list = paymentsByPromoId[pp.promoId] ?? [];
    list.push({ id: pp.id, dueDate: pp.dueDate, amountCents: pp.amountCents, note: pp.note });
    paymentsByPromoId[pp.promoId] = list;
  }

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
      if (estimate) {
        const variableCharges = projectVariableBillCardCharges({
          variableBills: variableBills.filter((bill) => bill.cardIds.includes(card.id)),
          cards: [card],
          startDate: estimate.window.start,
          endDate: estimate.window.end,
        })
          .filter((charge) => charge.cardId === card.id)
          .map((charge) => ({
            billId: charge.variableBillId,
            sourceId: charge.variableBillId,
            sourceType: "variable_bill" as const,
            name: charge.name,
            date: charge.date,
            amountCents: charge.amountCents,
          }));
        estimate.charges.push(...variableCharges);
        estimate.totalCents += variableCharges.reduce((sum, charge) => sum + charge.amountCents, 0);
      }
      const [statements, promos] = await Promise.all([
        listStatements(card.id),
        listPromosForCard(userId, card.id, true),
      ]);
      return {
        card,
        statements,
        estimate,
        linkedBillCount: linkedBills.length + linkedExtras.length + variableBills.filter((bill) => bill.cardIds.includes(card.id)).length,
        promos,
      };
    }),
  );

  return <CreditCardsClient initialCards={data} initialPaymentsByPromoId={paymentsByPromoId} />;
}
