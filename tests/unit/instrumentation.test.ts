import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

vi.mock("@/lib/db/client", () => ({
  runMigrations: () => {
    calls.push("runMigrations");
  },
}));
vi.mock("@/lib/push-scheduler", () => ({
  startPushScheduler: () => {
    calls.push("startPushScheduler");
  },
}));

describe("instrumentation register", () => {
  const original = process.env.NEXT_RUNTIME;
  beforeEach(() => {
    calls.length = 0;
    vi.resetModules();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = original;
  });

  it("runs migrations before the push scheduler on the node runtime", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const { register } = await import("../../instrumentation");
    await register();
    expect(calls).toEqual(["runMigrations", "startPushScheduler"]);
  });

  it("does not start the scheduler when migrations fail", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    vi.doMock("@/lib/db/client", () => ({
      runMigrations: () => {
        throw new Error("Database migration failed");
      },
    }));
    const { register } = await import("../../instrumentation");
    await expect(register()).rejects.toThrow("Database migration failed");
    expect(calls).toEqual([]);
  });

  it.each(["edge", undefined])("does nothing when NEXT_RUNTIME is %s", async (rt) => {
    if (rt === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = rt;
    const { register } = await import("../../instrumentation");
    await register();
    expect(calls).toEqual([]);
  });
});
