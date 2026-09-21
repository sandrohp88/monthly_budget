import { redirect } from "next/navigation";
import { runMigrations } from "@/lib/db/client";
import { requirePageUser } from "@/lib/auth";
import { getSettings, userExists } from "@/lib/repos";
import { log } from "@/lib/log";
import { AppShell, type SidebarSummary } from "@/components/app-shell";
import { buildProjection } from "@/lib/projection-server";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  runMigrations();
  if (!(await userExists())) redirect("/setup");

  const user = await requirePageUser();
  const userId = user.id;

  const settings = await getSettings(userId);
  const displayName = user.displayName || "there";
  const role = user.role;

  // Compact projection summary for the sidebar widget. `buildProjection` is
  // deduped per-request via React.cache, so this doesn't double the work on
  // pages (like the dashboard) that also call it.
  let sidebarSummary: SidebarSummary | null = null;
  try {
    const projection = await buildProjection(userId);
    if (projection) {
      const next30 = projection.rows.slice(0, 30).map((r) => r.balanceCents);
      const endCents = next30[next30.length - 1] ?? projection.startingBalanceCents;
      sidebarSummary = {
        startingBalanceCents: projection.startingBalanceCents,
        sparkline: next30,
        deltaCents: endCents - projection.startingBalanceCents,
      };
    }
  } catch (err) {
    log.warn(`sidebar projection failed: ${(err as Error).message}`);
  }

  return (
    <AppShell
      currency={settings?.currency ?? "USD"}
      displayName={displayName}
      role={role.toUpperCase()}
      sidebarSummary={sidebarSummary}
    >
      {children}
    </AppShell>
  );
}
