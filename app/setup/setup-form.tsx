"use client";

import * as React from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CardSubTag } from "@/components/ui/page-head";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/money-input";

export function SetupForm() {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [startingBalanceCents, setStartingBalanceCents] = React.useState(0);
  const [startingBalanceAsOf, setStartingBalanceAsOf] = React.useState(today);
  const [defaultPaycheckCents, setDefaultPaycheckCents] = React.useState(0);
  const [firstPaydayDate, setFirstPaydayDate] = React.useState(today);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  return (
    <div className="w-full max-w-lg">
      {/* Brand */}
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
            INITIAL_BOOTSTRAP // OWNER_PROVISION
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardSubTag>SETUP_PROMPT</CardSubTag>
            <CardTitle className="mt-0.5">CREATE OWNER ACCOUNT</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setLoading(true);
              setError(null);
              const res = await fetch("/api/setup", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  email,
                  password,
                  displayName,
                  startingBalanceCents,
                  startingBalanceAsOf,
                  defaultPaycheckCents,
                  firstPaydayDate,
                  payFrequencyDays: 14,
                  projectionMonths: 6,
                  currency: "USD",
                  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York",
                }),
              });
              if (!res.ok) {
                setError((await res.json().catch(() => ({}))).error ?? "setup failed");
                setLoading(false);
                return;
              }
              await signIn("credentials", { email, password, redirect: false });
              setLoading(false);
              router.push("/");
              router.refresh();
            }}
          >
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="displayName">DISPLAY NAME</Label>
                <Input
                  id="displayName"
                  required
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email">EMAIL</Label>
                <Input
                  id="email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="password">PASSWORD (MIN 8 CHARS)</Label>
                <Input
                  id="password"
                  type="password"
                  minLength={8}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="startingBalance">STARTING BALANCE</Label>
                <MoneyInput
                  id="startingBalance"
                  valueCents={startingBalanceCents}
                  onChangeCents={setStartingBalanceCents}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="startingBalanceAsOf">AS OF</Label>
                <Input
                  id="startingBalanceAsOf"
                  type="date"
                  required
                  value={startingBalanceAsOf}
                  onChange={(e) => setStartingBalanceAsOf(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="defaultPaycheck">DEFAULT PAYCHECK</Label>
                <MoneyInput
                  id="defaultPaycheck"
                  valueCents={defaultPaycheckCents}
                  onChangeCents={setDefaultPaycheckCents}
                />
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="firstPayday">FIRST PAYDAY</Label>
                <Input
                  id="firstPayday"
                  type="date"
                  required
                  value={firstPaydayDate}
                  onChange={(e) => setFirstPaydayDate(e.target.value)}
                />
              </div>
            </div>
            {error ? (
              <p className="rounded-sm border border-[rgba(239,68,68,0.3)] bg-[var(--red-glow)] px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-[var(--red)]">
                {error}
              </p>
            ) : null}
            <Button type="submit" variant="primary" className="w-full" disabled={loading}>
              {loading ? "PROVISIONING…" : "CREATE ACCOUNT"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
