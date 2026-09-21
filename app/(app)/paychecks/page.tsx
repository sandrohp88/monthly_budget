import { requirePageUser } from "@/lib/auth";
import { getSettings, listPaychecks } from "@/lib/repos";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import { PaychecksClient } from "./paychecks-client";

export const dynamic = "force-dynamic";

export default async function PaychecksPage() {
  const { id: userId } = await requirePageUser();
  const [paychecks, settings] = await Promise.all([listPaychecks(userId), getSettings(userId)]);
  return (
    <PaychecksClient
      initialPaychecks={paychecks}
      timezone={settings?.timezone ?? DEFAULT_TIMEZONE}
      defaultMonths={settings?.projectionMonths ?? 12}
    />
  );
}
