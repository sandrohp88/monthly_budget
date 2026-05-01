"use client";

import * as React from "react";
import { usePlaidLink } from "react-plaid-link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Link2 } from "lucide-react";

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
      }
    },
    onExit: () => {
      setLinkToken(null);
      setFetching(false);
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
      {exchanging ? "LINKING…" : fetching ? "LOADING…" : "LINK A NEW ACCOUNT"}
    </Button>
  );
}
