import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getSettings, listCategories, listCreditCards, listExtras } from "@/lib/repos";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import { ExtrasClient } from "./extras-client";

export const dynamic = "force-dynamic";

export default async function ExtrasPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");
  const [extras, categories, creditCards, settings] = await Promise.all([
    listExtras(userId),
    listCategories(userId),
    listCreditCards(userId, false),
    getSettings(userId),
  ]);
  return (
    <ExtrasClient
      initialExtras={extras}
      categories={categories.map((c) => c.name)}
      creditCards={creditCards}
      timezone={settings?.timezone ?? DEFAULT_TIMEZONE}
    />
  );
}
