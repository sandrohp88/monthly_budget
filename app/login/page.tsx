import { redirect } from "next/navigation";
import { runMigrations } from "@/lib/db/client";
import { userExists } from "@/lib/repos";
import { safeNextPath } from "@/lib/safe-redirect";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  runMigrations();
  if (!(await userExists())) {
    redirect("/setup");
  }
  const sp = await searchParams;
  // Only a same-origin path may come back from ?next= (review 2026-09-24 C03).
  const next = safeNextPath(sp.next);
  return (
    <div data-app-shell className="flex min-h-screen items-center justify-center bg-[var(--bg-0)] p-6">
      <LoginForm callbackUrl={next} />
    </div>
  );
}
