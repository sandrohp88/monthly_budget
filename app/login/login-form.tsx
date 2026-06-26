"use client";

import * as React from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CardSubTag } from "@/components/ui/page-head";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

export function LoginForm({ callbackUrl }: { callbackUrl: string }) {
  const router = useRouter();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  return (
    <div className="w-full max-w-sm">
      <div className="mb-6 flex items-center gap-3">
        <span
          className="block h-10 w-10 rounded-[8px] bg-cover bg-center"
          style={{
            backgroundImage: "url('/icons/bluefalls-mark.svg')",
            boxShadow: "0 10px 24px rgba(80, 214, 201, 0.2)",
          }}
          aria-hidden="true"
        />
        <div>
          <div className="text-[22px] font-extrabold tracking-normal text-[var(--text-0)]">
            Monthly Budget
          </div>
          <div className="text-[13px] text-[var(--text-3)]">
            Bluefalls finance
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardSubTag>Welcome back</CardSubTag>
            <CardTitle className="mt-0.5">Sign in</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setLoading(true);
              setError(null);
              const res = await signIn("credentials", {
                email,
                password,
                redirect: false,
                callbackUrl,
              });
              setLoading(false);
              if (!res || res.error) {
                setError("Invalid credentials or rate-limited.");
                return;
              }
              router.push(callbackUrl || "/");
              router.refresh();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error ? (
              <p className="rounded-[10px] border border-[rgba(239,68,68,0.3)] bg-[var(--red-glow)] px-3 py-2 text-[13px] text-[var(--red)]">
                {error}
              </p>
            ) : null}
            <Button type="submit" variant="primary" className="w-full" disabled={loading}>
              {loading ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="mt-4 text-[12px] text-[var(--text-3)]">
        Ready
      </div>
    </div>
  );
}
