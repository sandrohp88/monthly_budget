import { redirect } from "next/navigation";
import { runMigrations } from "@/lib/db/client";
import { auth } from "@/lib/auth";
import { archiveExpiredPromos, getSettings, userExists } from "@/lib/repos";
import { todayIso } from "@/lib/dates";
import { log } from "@/lib/log";
import { AppShell } from "@/components/app-shell";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  runMigrations();
  if (!(await userExists())) redirect("/setup");

  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const settings = await getSettings(userId);
  const displayName = session?.user?.name ?? "there";
  const role = (session?.user as { role?: string } | undefined)?.role ?? "MEMBER";

  // Sweep promos whose endDate has passed. Plaid sync used to be the only
  // trigger, which left non-Plaid users sitting on expired promos at full
  // remaining principal forever. Running it on every authenticated page load
  // is cheap (single indexed UPDATE, no-op when nothing is expired).
  try {
    const archived = await archiveExpiredPromos(userId, todayIso(settings?.timezone));
    if (archived > 0) {
      log.info(`archiveExpiredPromos: archived ${archived} expired promo(s) for user ${userId}`);
    }
  } catch (err) {
    // Never block page load on the sweep — if the table doesn't exist yet
    // (mid-migration) or any other transient hiccup, log and continue.
    log.warn(`archiveExpiredPromos failed: ${(err as Error).message}`);
  }

  return (
    <AppShell currency={settings?.currency ?? "USD"} displayName={displayName} role={role.toUpperCase()}>
      {children}
    </AppShell>
  );
}
