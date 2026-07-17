import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getSettings, listAssets } from "@/lib/repos";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import { AssetsClient } from "./assets-client";

export const dynamic = "force-dynamic";

export default async function AssetsPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");
  const [assets, settings] = await Promise.all([listAssets(userId), getSettings(userId)]);
  return (
    <AssetsClient initialAssets={assets} timezone={settings?.timezone ?? DEFAULT_TIMEZONE} />
  );
}
