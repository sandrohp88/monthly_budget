"use client";

import * as React from "react";
import { toast } from "sonner";
import { BellRing, BellOff, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/** applicationServerKey wants raw bytes; VAPID keys travel base64url. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type ServerState = {
  configured: boolean;
  publicKey: string | null;
  subscriptionCount: number;
  endpoints: string[];
};

/**
 * Settings card: enable/disable web-push on this device and send a test.
 * The server side (subscription storage + the hourly interest-alert
 * dispatcher) lives in lib/push.ts; this only manages the browser
 * subscription and hands it to /api/push.
 */
export function PushNotificationsCard() {
  const [supported, setSupported] = React.useState<boolean | null>(null);
  const [server, setServer] = React.useState<ServerState | null>(null);
  const [subscription, setSubscription] = React.useState<PushSubscription | null>(null);
  const [busy, setBusy] = React.useState(false);

  const refreshServer = React.useCallback(async () => {
    try {
      const res = await fetch("/api/push");
      if (res.ok) setServer((await res.json()) as ServerState);
    } catch {
      // status line falls back to "unavailable"
    }
  }, []);

  React.useEffect(() => {
    const ok =
      "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    setSupported(ok);
    void refreshServer();
    if (ok) {
      navigator.serviceWorker.ready
        .then((reg) => reg.pushManager.getSubscription())
        .then(setSubscription)
        .catch(() => setSubscription(null));
    }
  }, [refreshServer]);

  const enable = async () => {
    if (!server?.publicKey) return;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast.error("Notifications are blocked for this site — allow them in the browser settings.");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(server.publicKey),
      });
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error("browser returned an incomplete subscription");
      }
      const res = await fetch("/api/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
          userAgent: navigator.userAgent,
        }),
      });
      if (!res.ok) throw new Error("server rejected the subscription");
      setSubscription(sub);
      await refreshServer();
      toast.success("Push notifications enabled on this device");
    } catch (e) {
      toast.error(`Could not enable push: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!subscription) return;
    setBusy(true);
    try {
      const endpoint = subscription.endpoint;
      await subscription.unsubscribe();
      await fetch("/api/push", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      setSubscription(null);
      await refreshServer();
      toast.success("Push notifications disabled on this device");
    } catch (e) {
      toast.error(`Could not disable push: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const data = (await res.json()) as {
        sent?: number;
        interestAlert?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "test failed");
      if ((data.sent ?? 0) === 0) {
        toast.error("No device received the test — re-enable push on this device.");
      } else {
        toast.success(
          data.interestAlert
            ? `Sent the pending interest alert to ${data.sent} device${data.sent === 1 ? "" : "s"}`
            : `Test notification sent to ${data.sent} device${data.sent === 1 ? "" : "s"}`,
        );
      }
    } catch (e) {
      toast.error(`Test failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const enabledHere = subscription != null;

  return (
    <Card>
      <CardHeader className="px-4 py-3">
        <div className="flex items-center justify-between">
          <CardTitle className="mt-0.5">Notifications</CardTitle>
          {enabledHere ? <Badge variant="success">On this device</Badge> : null}
        </div>
        <div className="text-2xs text-[var(--text-2)]">
          Get a push notification when a card balance is due with no planned payment — the
          uncovered amount would start accruing interest.
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        {supported === false ? (
          <div className="text-2xs text-[var(--text-2)]">
            This browser doesn&apos;t support web push. On iPhone/iPad, install the app first
            (Share → Add to Home Screen) and enable notifications from inside the installed app.
          </div>
        ) : server && !server.configured ? (
          <div className="text-2xs text-[var(--text-2)]">
            Push is not configured on the server (VAPID keys missing) — see <code>.env.example</code>.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {enabledHere ? (
                <Button variant="outline" onClick={disable} disabled={busy}>
                  <BellOff className="h-3 w-3" /> Disable on this device
                </Button>
              ) : (
                <Button variant="primary" onClick={enable} disabled={busy || !server?.publicKey}>
                  <BellRing className="h-3 w-3" /> Enable on this device
                </Button>
              )}
              <Button
                variant="outline"
                onClick={sendTest}
                disabled={busy || (server?.subscriptionCount ?? 0) === 0}
              >
                <Send className="h-3 w-3" /> Send test
              </Button>
            </div>
            <div className="text-2xs text-[var(--text-3)]">
              {server
                ? `${server.subscriptionCount} device${server.subscriptionCount === 1 ? "" : "s"} subscribed · checks run hourly, daytime only (8:00–21:00 local)`
                : "Loading push status…"}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
