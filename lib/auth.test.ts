import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the Credentials provider config that lib/auth.ts hands to NextAuth,
// so the real authorize() can be called without a request or a database.
type Authorize = (raw: Record<string, unknown>) => Promise<unknown>;
const captured = vi.hoisted(() => ({ authorize: null as Authorize | null }));

vi.mock("next-auth", () => ({
  default: (config: { providers: { authorize: Authorize }[] }) => {
    captured.authorize = config.providers[0]?.authorize ?? null;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock("next-auth/providers/credentials", () => ({
  default: (provider: unknown) => provider,
}));

const argon2Mock = vi.hoisted(() => ({
  hash: vi.fn(async () => "$argon2id$dummy"),
  verify: vi.fn(async () => false),
  argon2id: 2,
}));
vi.mock("argon2", () => ({ default: argon2Mock }));

const userRow = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("./db/client", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ get: () => userRow.current }) }) }),
  }),
}));

import "./auth";

beforeEach(() => {
  argon2Mock.hash.mockClear();
  argon2Mock.verify.mockClear();
  userRow.current = undefined;
});

describe("Credentials authorize: no account-existence timing leak", () => {
  it("runs argon2 verify for an unknown email and still returns null", async () => {
    const result = await captured.authorize!({
      email: "nobody@example.com",
      password: "guess-123",
    });

    expect(result).toBeNull();
    expect(argon2Mock.verify).toHaveBeenCalledTimes(1);
    expect(argon2Mock.verify).toHaveBeenCalledWith("$argon2id$dummy", "guess-123");
    // The dummy hash uses the app's real Argon2id parameters.
    expect(argon2Mock.hash).toHaveBeenCalledWith(expect.any(String), {
      type: argon2Mock.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
    });
  });

  it("computes the dummy hash once per process", async () => {
    await captured.authorize!({ email: "a@example.com", password: "guess-123" });
    await captured.authorize!({ email: "b@example.com", password: "guess-456" });

    // At most one hash: zero when an earlier test already filled the cache.
    expect(argon2Mock.hash.mock.calls.length).toBeLessThanOrEqual(1);
    expect(argon2Mock.verify).toHaveBeenCalledTimes(2);
  });

  it("verifies a known email against the stored hash", async () => {
    userRow.current = {
      id: "u1",
      email: "known@example.com",
      displayName: "Known",
      passwordHash: "$argon2id$real",
      sessionVersion: 3,
    };
    argon2Mock.verify.mockResolvedValueOnce(true);

    const result = await captured.authorize!({
      email: "known@example.com",
      password: "right-pass",
    });

    expect(argon2Mock.verify).toHaveBeenCalledWith("$argon2id$real", "right-pass");
    expect(result).toEqual({
      id: "u1",
      email: "known@example.com",
      name: "Known",
      sessionVersion: 3,
    });
  });
});
