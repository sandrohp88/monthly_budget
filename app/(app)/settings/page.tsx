import { redirect } from "next/navigation";
import { requirePageUser } from "@/lib/auth";
import { getSettings, listCategories, listUsers } from "@/lib/repos";
import { SettingsClient } from "./settings-client";

export const dynamic = "force-dynamic";

/**
 * Zones the SERVER can format, which is exactly what settings validation
 * accepts (isSupportedTimeZone). Built here rather than in the browser so the
 * options can't drift from the validator or mismatch on hydration. The saved
 * value is always kept selectable.
 */
function supportedTimeZones(current: string): string[] {
  const zones = new Set(Intl.supportedValuesOf("timeZone"));
  zones.add("UTC");
  zones.add(current);
  return [...zones].sort();
}

export default async function SettingsPage() {
  const user = await requirePageUser();
  const userId = user.id;

  const settings = await getSettings(userId);
  if (!settings) redirect("/setup");

  const isAdmin = user.role === "admin";
  const [users, categories] = await Promise.all([
    isAdmin ? listUsers() : Promise.resolve([]),
    listCategories(userId),
  ]);

  return (
    <SettingsClient
      initial={settings}
      version={process.env.npm_package_version ?? "1.0.0"}
      currentUser={{
        id: userId,
        name: user.displayName,
        email: user.email,
        role: user.role,
      }}
      users={users}
      isAdmin={isAdmin}
      initialCategories={categories}
      timeZones={supportedTimeZones(settings.timezone)}
    />
  );
}
