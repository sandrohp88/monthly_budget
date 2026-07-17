/**
 * In-process hourly trigger for the interest-alert push dispatch. Started
 * once per server boot from instrumentation.ts — no external cron needed;
 * dedupe lives in the DB (per-subscription digest + lastNotifiedAt), so
 * restarts and dev hot-reloads can't double-notify.
 */

import { dispatchInterestAlerts, isPushConfigured } from "./push";

const HOURLY_MS = 60 * 60 * 1000;
const BOOT_DELAY_MS = 60 * 1000;

const globals = globalThis as typeof globalThis & {
  __financeOsPushTimer?: ReturnType<typeof setInterval>;
};

export function startPushScheduler(): void {
  // `next build` boots server instances to collect page data — no timers there.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (globals.__financeOsPushTimer) return;
  if (!isPushConfigured()) {
    console.warn("[push] VAPID_* env vars not set — push scheduler disabled");
    return;
  }

  const run = async () => {
    try {
      const s = await dispatchInterestAlerts();
      if (s.sent > 0 || s.pruned > 0 || s.failed > 0) {
        console.warn(
          `[push] interest-alert dispatch: sent=${s.sent} skipped=${s.skipped} pruned=${s.pruned} failed=${s.failed}`,
        );
      }
    } catch (e) {
      console.error("[push] interest-alert dispatch crashed:", e);
    }
  };

  // First pass shortly after boot (migrations have run by then), then hourly.
  const boot = setTimeout(run, BOOT_DELAY_MS);
  boot.unref?.();
  globals.__financeOsPushTimer = setInterval(run, HOURLY_MS);
  globals.__financeOsPushTimer.unref?.();
  console.warn("[push] scheduler started (hourly interest-alert dispatch)");
}
