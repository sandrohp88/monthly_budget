import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listBills, listCategories, listCreditCards, listVariableBills } from "@/lib/repos";
import { BillsClient } from "./bills-client";

export const dynamic = "force-dynamic";

export default async function BillsPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const [bills, variableBills, categories, cards] = await Promise.all([
    listBills(userId, true),
    listVariableBills(userId, true),
    listCategories(userId),
    listCreditCards(userId, true),
  ]);
  return (
    <BillsClient
      initialBills={bills}
      initialVariableBills={variableBills}
      categories={categories.map((c) => c.name)}
      cards={cards.map((c) => ({ id: c.id, name: c.name, isActive: c.isActive }))}
    />
  );
}
