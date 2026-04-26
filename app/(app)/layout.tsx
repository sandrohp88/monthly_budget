import { redirect } from "next/navigation";
import { runMigrations } from "@/lib/db/client";
import { auth } from "@/lib/auth";
import { getSettings, userExists } from "@/lib/repos";
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

  return (
    <AppShell currency={settings?.currency ?? "USD"} displayName={displayName} role={role.toUpperCase()}>
      {children}
    </AppShell>
  );
}
