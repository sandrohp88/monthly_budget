import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listAssets } from "@/lib/repos";
import { AssetsClient } from "./assets-client";

export const dynamic = "force-dynamic";

export default async function AssetsPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");
  const assets = await listAssets(userId);
  return <AssetsClient initialAssets={assets} />;
}
