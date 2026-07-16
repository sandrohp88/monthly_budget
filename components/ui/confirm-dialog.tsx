"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type ConfirmOptions = {
  title: string;
  description?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** `danger` uses the destructive button for irreversible actions. */
  tone?: "danger" | "default";
};

// Imperative confirm, in the spirit of sonner's `toast()`. `ConfirmHost` (mounted
// once in AppShell) registers the opener; callers just `await confirmDialog(...)`.
let opener: ((opts: ConfirmOptions) => Promise<boolean>) | null = null;

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  if (opener) return opener(opts);
  // Fallback if the host isn't mounted (e.g. SSR path) — never leaves a caller hanging.
  if (typeof window !== "undefined") return Promise.resolve(window.confirm(opts.title));
  return Promise.resolve(false);
}

export function ConfirmHost() {
  const [state, setState] = React.useState<{
    opts: ConfirmOptions;
    resolve: (v: boolean) => void;
  } | null>(null);

  React.useEffect(() => {
    opener = (opts) => new Promise<boolean>((resolve) => setState({ opts, resolve }));
    return () => {
      opener = null;
    };
  }, []);

  const close = React.useCallback(
    (value: boolean) => {
      setState((s) => {
        s?.resolve(value);
        return null;
      });
    },
    [],
  );

  const opts = state?.opts;

  return (
    <Dialog
      open={state != null}
      onOpenChange={(open) => {
        if (!open) close(false);
      }}
    >
      {opts ? (
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{opts.title}</DialogTitle>
            {opts.description ? (
              <DialogDescription>{opts.description}</DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              {opts.cancelText ?? "Cancel"}
            </Button>
            <Button
              type="button"
              variant={opts.tone === "danger" ? "destructive" : "primary"}
              onClick={() => close(true)}
              autoFocus
            >
              {opts.confirmText ?? "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
