import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listPaychecks } from "@/lib/repos";
import { PaychecksClient } from "./paychecks-client";

export const dynamic = "force-dynamic";

export default async function PaychecksPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");
  const paychecks = await listPaychecks(userId);
  return <PaychecksClient initialPaychecks={paychecks} />;
}
