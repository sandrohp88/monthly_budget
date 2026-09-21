import { redirect } from "next/navigation";
import { requirePageUser } from "@/lib/auth";
import { getSettings, listCategories, listUsers } from "@/lib/repos";
import { SettingsClient } from "./settings-client";

export const dynamic = "force-dynamic";

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
    />
  );
}
