import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listCategories, listExtras } from "@/lib/repos";
import { ExtrasClient } from "./extras-client";

export const dynamic = "force-dynamic";

export default async function ExtrasPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");
  const [extras, categories] = await Promise.all([
    listExtras(userId),
    listCategories(userId),
  ]);
  return <ExtrasClient initialExtras={extras} categories={categories.map((c) => c.name)} />;
}
