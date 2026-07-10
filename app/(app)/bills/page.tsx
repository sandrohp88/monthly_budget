import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { buildProjection } from "@/lib/projection-server";
import {
  listBills,
  listBillPaymentOverridesForUser,
  listCategories,
  listCreditCards,
  listVariableBills,
} from "@/lib/repos";
import { BillsClient, type LastPaid } from "./bills-client";

export const dynamic = "force-dynamic";

export default async function BillsPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const [bills, variableBills, categories, cards, overrides, projection] = await Promise.all([
    listBills(userId, true),
    listVariableBills(userId, true),
    listCategories(userId),
    listCreditCards(userId, true),
    listBillPaymentOverridesForUser(userId),
    // Cached per request (the layout already builds it) — reused for the
    // reconciled "last paid" markers.
    buildProjection(userId),
  ]);

  // Latest settled occurrence per bill (lists arrive ascending by date).
  const lastPaidByBill: Record<string, LastPaid> = {};
  for (const [billId, occurrences] of Object.entries(projection?.paidOccurrencesByBill ?? {})) {
    const last = occurrences[occurrences.length - 1];
    if (last) lastPaidByBill[billId] = last;
  }

  return (
    <BillsClient
      initialBills={bills}
      lastPaidByBill={lastPaidByBill}
      initialVariableBills={variableBills}
      categories={categories.map((c) => c.name)}
      cards={cards.map((c) => ({ id: c.id, name: c.name, isActive: c.isActive }))}
      initialOverrides={overrides.map((o) => ({
        id: o.id,
        billId: o.billId,
        dueDate: o.dueDate,
        amountCents: o.amountCents,
        notes: o.notes,
      }))}
    />
  );
}
