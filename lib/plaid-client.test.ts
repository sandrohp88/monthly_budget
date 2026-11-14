import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalAxiosRequestConfig } from "axios";

vi.mock("server-only", () => ({}));

describe("getPlaidClient", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("PLAID_ENV", "sandbox");
    vi.stubEnv("PLAID_CLIENT_ID", "test-client-id");
    vi.stubEnv("PLAID_SECRET", "test-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("configures a 30-second timeout on Plaid requests", async () => {
    const { getPlaidClient } = await import("./plaid-client");
    const response = await getPlaidClient().itemRemove(
      { access_token: "test-token" },
      {
        adapter: async (config: InternalAxiosRequestConfig) => ({
          data: {}, status: 200, statusText: "OK", headers: {}, config,
        }),
      },
    );

    expect(response.config.timeout).toBe(30_000);
  });
});
