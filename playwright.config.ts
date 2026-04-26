import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:3217",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npx next start -p 3217 -H 127.0.0.1",
    url: "http://127.0.0.1:3217",
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATABASE_URL: "file:./data/test.db",
      AUTH_SECRET: "test-secret-test-secret-test-secret-test",
      AUTH_URL: "http://127.0.0.1:3217",
      NODE_ENV: "production",
    },
  },
});
