import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("./auth", () => ({
  hashPassword: async (password: string) => `mock-hash-${password}`,
}));

const linkTokenCreate = vi.fn();

vi.mock("./plaid-client", () => ({
  getPlaidClient: () => ({ linkTokenCreate }),
}));

import { createLinkToken } from "./plaid-sync";

describe("createLinkToken", () => {
  beforeEach(() => {
    linkTokenCreate.mockReset();
    linkTokenCreate.mockResolvedValue({ data: { link_token: "link-token" } });
    delete process.env.APP_URL;
  });

  it("requests the maximum transaction history during Link initialization", async () => {
    await expect(createLinkToken("user-1")).resolves.toBe("link-token");

    expect(linkTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        transactions: { days_requested: 730 },
      }),
    );
  });

  it("includes the OAuth redirect URI when APP_URL is configured", async () => {
    process.env.APP_URL = "https://budget.example.test/";

    await createLinkToken("user-1");

    expect(linkTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        redirect_uri: "https://budget.example.test/plaid/oauth-return",
      }),
    );
  });

  it("registers the webhook receiver when APP_URL is configured", async () => {
    process.env.APP_URL = "https://budget.example.test/";

    await createLinkToken("user-1");

    expect(linkTokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        webhook: "https://budget.example.test/api/plaid/webhook",
      }),
    );
  });

  it("omits the webhook param without APP_URL (dev)", async () => {
    await createLinkToken("user-1");

    expect(linkTokenCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({ webhook: expect.anything() }),
    );
  });
});
