import { redirect } from "next/navigation";
import { runMigrations } from "@/lib/db/client";
import { userExists } from "@/lib/repos";
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
  const next = typeof sp.next === "string" ? sp.next : "/";
  return (
    <div data-app-shell className="flex min-h-screen items-center justify-center bg-[var(--bg-0)] p-6">
      <LoginForm callbackUrl={next} />
    </div>
  );
}
