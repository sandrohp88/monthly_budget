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

// Static imports run first, so this is what loading lib/auth.ts did.
const hashCallsAtImport = [...argon2Mock.hash.mock.calls];

beforeEach(() => {
  argon2Mock.verify.mockClear();
  userRow.current = undefined;
});

describe("Credentials authorize: no account-existence timing leak", () => {
  it("starts the dummy hash at module load, with the real Argon2id parameters", () => {
    expect(hashCallsAtImport).toEqual([
      [expect.any(String), { type: argon2Mock.argon2id, memoryCost: 19_456, timeCost: 2 }],
    ]);
  });

  it("runs argon2 verify for an unknown email and still returns null", async () => {
    const result = await captured.authorize!({
      email: "nobody@example.com",
      password: "guess-123",
    });

    expect(result).toBeNull();
    expect(argon2Mock.verify).toHaveBeenCalledTimes(1);
    expect(argon2Mock.verify).toHaveBeenCalledWith("$argon2id$dummy", "guess-123");
  });

  it("computes the dummy hash once per process", async () => {
    await captured.authorize!({ email: "a@example.com", password: "guess-123" });
    await captured.authorize!({ email: "b@example.com", password: "guess-456" });

    expect(argon2Mock.hash).toHaveBeenCalledTimes(1); // the one at module load
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

  it("does not cache or crash on a failed eager hash; the next login retries it", async () => {
    vi.resetModules();
    argon2Mock.hash.mockClear();
    argon2Mock.hash.mockRejectedValueOnce(new Error("argon2 unavailable"));
    await import("./auth"); // fresh module: its eager hash rejects
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await captured.authorize!({ email: "x@example.com", password: "guess-789" });

    expect(result).toBeNull();
    expect(argon2Mock.hash).toHaveBeenCalledTimes(2);
    expect(argon2Mock.verify).toHaveBeenCalledWith("$argon2id$dummy", "guess-789");
  });
});
