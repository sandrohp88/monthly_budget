"use client";

/** How long sign-out waits for each push clean-up step before moving on. */
export const PUSH_SIGNOUT_TIMEOUT_MS = 3000;

/**
 * Remove one endpoint's row on the server (DELETE /api/push). The route is
 * scoped to the signed-in user, so it needs the session cookie. Shared by the
 * settings card's "Disable on this device" and by sign-out.
 */
export function deletePushSubscriptionOnServer(
  endpoint: string,
  init: { signal?: AbortSignal } = {},
): Promise<Response> {
  return fetch("/api/push", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
    signal: init.signal,
  });
}

/** Resolve to `undefined` instead of waiting longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Drop this browser's push subscription before the session ends, so a shared
 * device stops getting the previous user's card alerts (review 2026-11-10
 * AUTH-5). Order: the server row first (it needs the session cookie), then
 * the browser subscription. Other devices of the same user are untouched.
 *
 * Best-effort and bounded: it never throws, and each step gives up after
 * `timeoutMs`, so being offline or a failing route never blocks sign-out.
 */
export async function removePushSubscriptionOnThisDevice(
  timeoutMs = PUSH_SIGNOUT_TIMEOUT_MS,
): Promise<void> {
  let subscription: PushSubscription | null | undefined;
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (typeof window === "undefined" || !("PushManager" in window)) return;
    // getRegistration(), not .ready: .ready never settles without a worker.
    const registration = await within(navigator.serviceWorker.getRegistration(), timeoutMs);
    if (!registration) return;
    subscription = await within(registration.pushManager.getSubscription(), timeoutMs);
  } catch {
    return; // blocked storage / unsupported: nothing subscribed here
  }
  if (!subscription) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await deletePushSubscriptionOnServer(subscription.endpoint, { signal: controller.signal });
  } catch {
    // Offline or timed out: the browser unsubscribe below still stops
    // delivery, and the dispatcher prunes the row on the push service's 410.
  } finally {
    clearTimeout(timer);
  }

  try {
    await within(subscription.unsubscribe(), timeoutMs);
  } catch {
    // Push service unreachable: nothing more the client can do.
  }
}
