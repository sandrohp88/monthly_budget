import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getSettings, listCategories, listUsers } from "@/lib/repos";
import { SettingsClient } from "./settings-client";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth();
  const user = session?.user as { id?: string; name?: string; email?: string; role?: string } | undefined;
  const userId = user?.id;
  if (!userId) redirect("/login");

  const settings = await getSettings(userId);
  if (!settings) redirect("/setup");

  const isAdmin = user?.role === "admin";
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
        name: user?.name ?? "",
        email: user?.email ?? "",
        role: user?.role ?? "member",
      }}
      users={users}
      isAdmin={isAdmin}
      initialCategories={categories}
    />
  );
}
