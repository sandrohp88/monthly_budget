import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listBills, listCategories } from "@/lib/repos";
import { BillsClient } from "./bills-client";

export const dynamic = "force-dynamic";

export default async function BillsPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const [bills, categories] = await Promise.all([
    listBills(userId, true),
    listCategories(userId),
  ]);
  return <BillsClient initialBills={bills} categories={categories.map((c) => c.name)} />;
}
