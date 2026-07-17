import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getSettings, listPaychecks } from "@/lib/repos";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import { PaychecksClient } from "./paychecks-client";

export const dynamic = "force-dynamic";

export default async function PaychecksPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");
  const [paychecks, settings] = await Promise.all([listPaychecks(userId), getSettings(userId)]);
  return (
    <PaychecksClient
      initialPaychecks={paychecks}
      timezone={settings?.timezone ?? DEFAULT_TIMEZONE}
    />
  );
}
