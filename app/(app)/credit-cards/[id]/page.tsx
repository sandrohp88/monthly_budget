import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  getCreditCard,
  getSettings,
  listAllPromoPayments,
  listBills,
  listCreditCardPaymentOverridesForUser,
  listExtras,
  listPlaidAccounts,
  listPlaidItems,
  listPromosForCard,
  listStatements,
  listVariableBills,
} from "@/lib/repos";
import { estimateCurrentCycle } from "@/lib/credit-cards";
import { paydownTargetDate } from "@/lib/card-payments";
import { DEFAULT_TIMEZONE, todayIso } from "@/lib/dates";
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

  const [
    statements,
    promos,
    allBills,
    allExtras,
    allPromoPayments,
    variableBills,
    accounts,
    items,
    paymentOverrides,
    settings,
  ] = await Promise.all([
    listStatements(card.id),
    listPromosForCard(userId, card.id, true),
    listBills(userId, false), // active only — archived bills don't predict charges
    listExtras(userId),
    listAllPromoPayments(userId),
    listVariableBills(userId, false),
    listPlaidAccounts(userId),
    listPlaidItems(userId),
    listCreditCardPaymentOverridesForUser(userId),
    getSettings(userId),
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

  const timezone = settings?.timezone ?? DEFAULT_TIMEZONE;
  const today = todayIso(timezone);

  // Calendar-scheduled paydowns (`pays-down:`) on this card that still lie
  // ahead. Once applied to the card they credit the promo balance (see
  // lib/card-payments.ts), so the promo planner surfaces them to explain why a
  // promo schedule can be fully or partly covered before it reaches the calendar.
  const scheduledCardPayments = paymentOverrides
    .filter(
      (o) => o.cardId === card.id && o.dueDate >= today && paydownTargetDate(o.notes) != null,
    )
    .map((o) => ({ date: o.dueDate, amountCents: o.amountCents }))
    .sort((a, b) => a.date.localeCompare(b.date));

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
      scheduledCardPayments={scheduledCardPayments}
      mask={account?.mask ?? null}
      institution={institution}
      accountBalanceCents={account?.balanceCents ?? null}
      timezone={timezone}
    />
  );
}
