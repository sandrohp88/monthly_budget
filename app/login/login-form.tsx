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
      {/* Brand block matching the sidebar */}
      <div className="mb-6 flex items-center gap-3">
        <div
          className="grid h-8 w-8 place-items-center rounded-sm bg-[var(--mint)] text-[15px] font-extrabold text-[var(--bg-0)]"
          style={{ boxShadow: "0 0 16px var(--mint-glow)" }}
        >
          $
        </div>
        <div>
          <div className="text-[14px] font-bold uppercase tracking-[0.12em] text-[var(--text-0)]">
            FINANCE_OS
          </div>
          <div className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-3)]">
            v1.0.0 // local
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardSubTag>AUTH_PROMPT</CardSubTag>
            <CardTitle className="mt-0.5">SIGN IN</CardTitle>
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
                setError("INVALID CREDENTIALS OR RATE-LIMITED");
                return;
              }
              router.push(callbackUrl || "/");
              router.refresh();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="email">EMAIL</Label>
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
              <Label htmlFor="password">PASSWORD</Label>
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
              <p className="rounded-sm border border-[rgba(239,68,68,0.3)] bg-[var(--red-glow)] px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-[var(--red)]">
                {error}
              </p>
            ) : null}
            <Button type="submit" variant="primary" className="w-full" disabled={loading}>
              {loading ? "AUTHENTICATING…" : "SIGN IN"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="mt-4 flex items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-[var(--text-3)]">
        <span>{">"}</span>
        <span>READY</span>
        <span className="blink text-[var(--mint)]">_</span>
      </div>
    </div>
  );
}
