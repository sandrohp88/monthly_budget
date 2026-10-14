import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

vi.mock("server-only", () => ({}));

vi.mock("./auth", () => ({
  hashPassword: async (p: string) => `mock-hash-${p}`,
}));

// Projection "today" is the user's zone, not UTC. Pinned here so an early
// deposit's calendar day can't drift with the machine timezone.
vi.mock("./dates", async (importActual) => {
  const actual = await importActual<typeof import("./dates")>();
  return {
    ...actual,
    todayIso: () => "2026-05-04",
  };
});

import { __resetDbCacheForTests, getDb, runMigrations } from "./db/client";
import { settings, users } from "./db/schema";
import { newId } from "./ids";
import { buildProjection } from "./projection-server";
import { matchPaycheckDeposits } from "./paycheck-reconciliation";
import {
  createPaycheck,
  deletePaycheck,
  getPaycheck,
  listPaychecks,
  listUnreconciledPaychecksInRange,
  settlePaycheckWithDraft,
} from "./repos";

let dbDir: string;

beforeEach(() => {
  __resetDbCacheForTests();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-paycheck-removal-"));
  process.env.DATABASE_URL = `file:${path.join(dbDir, "test.db")}`;
  getDb();
  runMigrations();
});

afterEach(() => {
  __resetDbCacheForTests();
  try {
    fs.rmSync(dbDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

async function makeUser(): Promise<{ id: string }> {
  const db = getDb();
  const id = newId();
  await db
    .insert(users)
    .values({
      id,
      email: "removal@example.com",
      passwordHash: "x".repeat(64),
      displayName: "Removal Tester",
      role: "admin",
    })
    .run();
  await db
    .insert(settings)
    .values({
      id: newId(),
      userId: id,
      startingBalanceCents: 1_000_00,
      defaultPaycheckCents: 0,
      firstPaydayDate: "2026-05-06",
      payFrequencyDays: 14,
      projectionMonths: 2,
      currency: "USD",
      timezone: "America/New_York",
    })
    .run();
  return { id };
}

function paycheckIncome(rows: { date: string; events: { kind: string; label: string; amountCents: number }[] }[] | undefined, date: string) {
  return (rows ?? [])
    .find((r) => r.date === date)
    ?.events.filter((e) => e.kind === "paycheck" && e.amountCents > 0);
}

describe("deleting a paycheck occurrence", () => {
  it("drops it from the projection at once and does not let deposit reconciliation restore it", async () => {
    const user = await makeUser();
    // Scheduled Friday. The deposit landed Wednesday — two days early — and
    // was the paycheck plus a bonus, so it is past the matcher's 2× ceiling.
    // Matching that combined deposit is a separate change; this test only
    // locks that deleting the occurrence forgets it.
    const early = await createPaycheck(user.id, {
      payDate: "2026-05-06",
      amountCents: 2_000_00,
      note: "EARLYSHIFT",
    });
    const later = await createPaycheck(user.id, {
      payDate: "2026-05-20",
      amountCents: 2_000_00,
      note: "EARLYSHIFT",
    });

    const combinedDeposit = {
      id: "dep-early-bonus",
      date: "2026-05-04",
      description: "PAYROLL ACH BONUS",
      merchantName: null,
      amountCents: -4_500_00,
    };
    expect(matchPaycheckDeposits([early, later], [combinedDeposit])).toEqual([]);

    const before = await buildProjection(user.id);
    expect(paycheckIncome(before?.rows, "2026-05-06")).toEqual([
      expect.objectContaining({ label: "EARLYSHIFT", amountCents: 2_000_00 }),
    ]);

    await deletePaycheck(user.id, early.id);

    const after = await buildProjection(user.id);
    expect(paycheckIncome(after?.rows, "2026-05-06") ?? []).toEqual([]);
    expect(paycheckIncome(after?.rows, "2026-05-20")).toEqual([
      expect.objectContaining({ label: "EARLYSHIFT", amountCents: 2_000_00 }),
    ]);
    // The schedule's other rows stay. Nothing fills the hole from cadence.
    expect(after?.rows.some((r) => r.events.some((e) => e.kind === "paycheck" && e.label === "EARLYSHIFT" && r.date === "2026-05-06"))).toBe(false);

    // Migration 0029 consumes a draft against an existing active row. An
    // archived occurrence is not a candidate, and settling it is a no-op —
    // the next sync cannot bring the deleted paycheck back.
    expect(
      await listUnreconciledPaychecksInRange(user.id, "2026-04-01", "2026-06-01"),
    ).toEqual([expect.objectContaining({ id: later.id })]);
    expect(
      await settlePaycheckWithDraft(user.id, {
        paycheckId: early.id,
        draftId: combinedDeposit.id,
        amountCents: 4_500_00,
        date: combinedDeposit.date,
      }),
    ).toBeNull();
    expect(await getPaycheck(user.id, early.id)).toMatchObject({
      isActive: false,
      actualReceived: false,
      settledByDraftId: null,
    });
    expect(await listPaychecks(user.id)).toEqual([expect.objectContaining({ id: later.id })]);

    const afterSync = await buildProjection(user.id);
    expect(paycheckIncome(afterSync?.rows, "2026-05-06") ?? []).toEqual([]);
  });
});
