"use client";

import * as React from "react";
import { usePlaidLink } from "react-plaid-link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Link2 } from "lucide-react";
import { PLAID_LINK_TOKEN_STORAGE_KEY } from "@/lib/plaid-link-storage";

interface PlaidLinkButtonProps {
  onLinked: () => void;
}

export function PlaidLinkButton({ onLinked }: PlaidLinkButtonProps) {
  const [linkToken, setLinkToken] = React.useState<string | null>(null);
  const [fetching, setFetching] = React.useState(false);
  const [exchanging, setExchanging] = React.useState(false);

  // Fetch a link token when the user clicks the button.
  const fetchLinkToken = async () => {
    setFetching(true);
    try {
      const res = await fetch("/api/plaid/link-token", { method: "POST" });
      const json = await res.json() as { linkToken?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed to initialize Plaid");
      // Persist so the OAuth-return page can reopen Link with the same token
      // after the bank redirects the browser back.
      try {
        window.localStorage.setItem(PLAID_LINK_TOKEN_STORAGE_KEY, json.linkToken!);
      } catch {
        // localStorage may be unavailable in private mode; OAuth banks will fail
        // gracefully on the return page, non-OAuth banks still work.
      }
      setLinkToken(json.linkToken!);
    } catch (err) {
      toast.error((err as Error).message);
      setFetching(false);
    }
  };

  const { open, ready } = usePlaidLink({
    token: linkToken,
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
        const json = await res.json() as { error?: string };
        if (!res.ok) throw new Error(json.error ?? "Exchange failed");
        toast.success("Account linked successfully");
        onLinked();
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        setExchanging(false);
        setLinkToken(null);
        setFetching(false);
        try { window.localStorage.removeItem(PLAID_LINK_TOKEN_STORAGE_KEY); } catch {}
      }
    },
    onExit: () => {
      setLinkToken(null);
      setFetching(false);
      try { window.localStorage.removeItem(PLAID_LINK_TOKEN_STORAGE_KEY); } catch {}
    },
  });

  // Once the token arrives and Plaid Link is ready, open it automatically.
  React.useEffect(() => {
    if (linkToken && ready) {
      open();
    }
  }, [linkToken, ready, open]);

  return (
    <Button
      id="plaid-link-button"
      variant="primary"
      onClick={fetchLinkToken}
      disabled={fetching || exchanging}
    >
      <Link2 className="h-3 w-3" />
      {exchanging ? "Linking…" : fetching ? "Loading…" : "Link a new account"}
    </Button>
  );
}
