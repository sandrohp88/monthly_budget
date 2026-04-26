import { redirect } from "next/navigation";
import { runMigrations } from "@/lib/db/client";
import { userExists } from "@/lib/repos";
import { SetupForm } from "./setup-form";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
  runMigrations();
  if (await userExists()) {
    redirect("/login");
  }
  return (
    <div data-app-shell className="flex min-h-screen items-center justify-center bg-[var(--bg-0)] p-6">
      <SetupForm />
    </div>
  );
}
