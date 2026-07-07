import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Reports lives on /ledger as a tab now (see ledger/ledger-tabs.tsx and
 * reports-data.ts). Kept as a redirect so old bookmarks keep working.
 */
export default function ReportsRedirect() {
  redirect("/ledger?tab=reports");
}
