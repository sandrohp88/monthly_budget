import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  getCreditCard,
  listAllPromoPayments,
  listBills,
  listExtras,
  listPlaidAccounts,
  listPlaidItems,
  listPromosForCard,
  listStatements,
  listVariableBills,
} from "@/lib/repos";
import { estimateCurrentCycle } from "@/lib/credit-cards";
import { todayIso } from "@/lib/dates";
import { projectVariableBillCardCharges } from "@/lib/variable-bills";
import { CardDetailClient } from "./card-detail-client";

export const dynamic = "force-dynamic";

export default async function CreditCardDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const { id } = await params;
  const card = await getCreditCard(userId, id);
  if (!card) notFound();

  const [statements, promos, allBills, allExtras, allPromoPayments, variableBills, accounts, items] =
    await Promise.all([
      listStatements(card.id),
      listPromosForCard(userId, card.id, true),
      listBills(userId, false), // active only — archived bills don't predict charges
      listExtras(userId),
      listAllPromoPayments(userId),
      listVariableBills(userId, false),
      listPlaidAccounts(userId),
      listPlaidItems(userId),
    ]);

  const paymentsByPromoId: Record<
    string,
    Array<{ id: string; dueDate: string; amountCents: number; note: string | null }>
  > = {};
  const promoIds = new Set(promos.map((p) => p.id));
  for (const pp of allPromoPayments) {
    if (!promoIds.has(pp.promoId)) continue;
    const list = paymentsByPromoId[pp.promoId] ?? [];
    list.push({ id: pp.id, dueDate: pp.dueDate, amountCents: pp.amountCents, note: pp.note });
    paymentsByPromoId[pp.promoId] = list;
  }

  const today = todayIso();
  const linkedBills = allBills.filter((b) => b.paidViaCardId === card.id);
  const linkedExtras = allExtras.filter((e) => e.paidViaCardId === card.id);
  const linkedVariableBills = variableBills.filter((bill) => bill.cardIds.includes(card.id));

  const estimate = card.isActive
    ? estimateCurrentCycle(card, linkedBills, today, linkedExtras)
    : null;
  if (estimate) {
    const variableCharges = projectVariableBillCardCharges({
      variableBills: linkedVariableBills,
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

  const account = card.plaidAccountId
    ? accounts.find((a) => a.id === card.plaidAccountId)
    : undefined;
  const institution = account
    ? (items.find((i) => i.id === account.itemId)?.institutionName ?? null)
    : null;

  return (
    <CardDetailClient
      card={card}
      statements={statements}
      promos={promos}
      estimate={estimate}
      linkedBillCount={linkedBills.length + linkedExtras.length + linkedVariableBills.length}
      paymentsByPromoId={paymentsByPromoId}
      mask={account?.mask ?? null}
      institution={institution}
      accountBalanceCents={account?.balanceCents ?? null}
    />
  );
}
