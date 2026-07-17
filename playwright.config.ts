import { defineConfig, devices } from "@playwright/test";

// Default port 3000 matches local .env / AUTH_URL. On machines where 3000 is
// unusable (e.g. inside a Windows WinNAT excluded port range), run with
// E2E_PORT=3200 — AUTH_URL below follows the port so the Host-header guard
// (middleware 421) keeps passing.
const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npx next build && npx next start -p ${PORT} -H localhost`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATABASE_URL: "file:./data/test.db",
      AUTH_SECRET: "test-secret-test-secret-test-secret-test",
      AUTH_URL: BASE_URL,
      NODE_ENV: "production",
      // Test-only VAPID fixture keypair (never used against a real push
      // service — e2e subscriptions carry fake endpoints). Lets the /api/push
      // routes and the settings card run in their configured state.
      VAPID_PUBLIC_KEY:
        "BARIVisiXdoFAdJNsdqR6T9G5l5zDhYFgzc_KvfncIcr5yQbAccGlI0L4vcJIcPiOH7Qp4Hx8LhHf6co-K7MeE8",
      VAPID_PRIVATE_KEY: "EkI5kBL1QgjMCeUKvWyDQfRswkvn7Ornbc1FVeuoijw",
      VAPID_SUBJECT: "mailto:e2e@example.com",
    },
  },
});
