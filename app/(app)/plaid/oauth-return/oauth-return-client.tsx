"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { usePlaidLink } from "react-plaid-link";
import { toast } from "sonner";
import { PLAID_LINK_TOKEN_STORAGE_KEY } from "@/lib/plaid-link-storage";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CardSubTag } from "@/components/ui/page-head";

/**
 * OAuth return handler for Plaid Link.
 *
 * Flow:
 *   1. User clicks "Link a new account" on /accounts → PlaidLinkButton creates
 *      a link_token, stashes it in localStorage, and opens Link.
 *   2. User picks an OAuth-required institution (e.g. Navy Federal). Plaid
 *      navigates the browser to the bank's OAuth page.
 *   3. Bank redirects back to APP_URL/plaid/oauth-return?oauth_state_id=…
 *   4. THIS PAGE: read link_token from localStorage, re-open Link with
 *      `receivedRedirectUri = window.location.href`. Link picks up where it
 *      left off and finishes the connection.
 *   5. onSuccess: exchange the public_token for a permanent access_token via
 *      the existing /api/plaid/exchange endpoint, then go back to /accounts.
 */
export function OAuthReturnClient() {
  const router = useRouter();
  const [linkToken, setLinkToken] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [exchanging, setExchanging] = React.useState(false);

  React.useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PLAID_LINK_TOKEN_STORAGE_KEY);
      if (!stored) {
        setError(
          "Couldn't find the original link session. Please go back to Accounts and start the link again.",
        );
        return;
      }
      setLinkToken(stored);
    } catch {
      setError("This browser blocked localStorage, which Plaid OAuth needs.");
    }
  }, []);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    receivedRedirectUri: typeof window !== "undefined" ? window.location.href : undefined,
    onSuccess: async (publicToken, metadata) => {
      setExchanging(true);
      try {
        const res = await fetch("/api/plaid/exchange", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            publicToken,
            institutionId: metadata.institution?.institution_id ?? "unknown",
            institutionName: metadata.institution?.name ?? "Unknown Institution",
          }),
        });
        const json = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(json.error ?? "Exchange failed");
        toast.success("Account linked successfully");
        try { window.localStorage.removeItem(PLAID_LINK_TOKEN_STORAGE_KEY); } catch {}
        router.replace("/accounts");
      } catch (err) {
        toast.error((err as Error).message);
        setError((err as Error).message);
      } finally {
        setExchanging(false);
      }
    },
    onExit: (err) => {
      try { window.localStorage.removeItem(PLAID_LINK_TOKEN_STORAGE_KEY); } catch {}
      if (err) {
        setError(err.display_message ?? err.error_message ?? "Plaid Link was closed before finishing.");
        return;
      }
      router.replace("/accounts");
    },
  });

  // Auto-open as soon as Link is ready — the user shouldn't have to click anything.
  React.useEffect(() => {
    if (linkToken && ready && !exchanging) {
      open();
    }
  }, [linkToken, ready, exchanging, open]);

  return (
    <div className="fade-in flex justify-center pt-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardSubTag>PLAID_OAUTH</CardSubTag>
          <CardTitle>FINISHING LINK…</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm tracking-[0.12em]">
          {error ? (
            <p className="text-[color:var(--destructive)]">{error}</p>
          ) : exchanging ? (
            <p>EXCHANGING TOKEN…</p>
          ) : (
            <p>RETURNING FROM BANK. ONE MOMENT.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
