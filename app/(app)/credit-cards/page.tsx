import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listCreditCards, listStatements } from "@/lib/repos";
import { CreditCardsClient } from "./credit-cards-client";

export const dynamic = "force-dynamic";

export default async function CreditCardsPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const cards = await listCreditCards(userId, true);
  const data = await Promise.all(
    cards.map(async (card) => ({ card, statements: await listStatements(card.id) })),
  );
  return <CreditCardsClient initialCards={data} />;
}
