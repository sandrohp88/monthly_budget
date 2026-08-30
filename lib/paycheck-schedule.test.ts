import { describe, expect, it } from "vitest";
import {
  describeCadence,
  generateDates,
  inferCadence,
  isSchedulable,
  planSchedule,
  sequenceLabel,
  summarizeSequences,
} from "./paycheck-schedule";
import type { PaycheckRow } from "./db/schema";

const TODAY = "2026-08-30";

function pay(over: Partial<PaycheckRow> = {}): PaycheckRow {
  return {
    id: "p1",
    userId: "u1",
    payDate: "2026-09-11",
    amountCents: 3974_00,
    note: null,
    actualReceived: false,
    actualAmountCents: null,
    actualDate: null,
    settledByDraftId: null,
    isActive: true,
    createdAt: 0,
    ...over,
  };
}

describe("sequenceLabel", () => {
  it("treats null, empty and whitespace notes as the one unlabelled sequence", () => {
    expect(sequenceLabel(null)).toBe("");
    expect(sequenceLabel("")).toBe("");
    expect(sequenceLabel("   ")).toBe("");
    expect(sequenceLabel(" Husband ")).toBe("Husband");
  });
});

describe("isSchedulable", () => {
  it("protects received and past rows, allows future unreconciled ones", () => {
    expect(isSchedulable(pay({ payDate: "2026-09-11" }), TODAY)).toBe(true);
    expect(isSchedulable(pay({ payDate: TODAY }), TODAY)).toBe(true);
    expect(isSchedulable(pay({ payDate: "2026-08-29" }), TODAY)).toBe(false);
    expect(isSchedulable(pay({ payDate: "2026-09-11", actualReceived: true }), TODAY)).toBe(false);
    expect(isSchedulable(pay({ payDate: "2026-09-11", isActive: false }), TODAY)).toBe(false);
  });
});

describe("inferCadence", () => {
  it("reads a biweekly run", () => {
    expect(inferCadence(["2026-09-11", "2026-09-25", "2026-10-09"])).toEqual({
      kind: "everyDays",
      days: 14,
    });
  });

  it("reads a monthly run as monthly, not as noisy day-gaps", () => {
    // 31, 30, 31 day gaps — a most-common-gap reading calls this irregular.
    expect(inferCadence(["2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01"])).toEqual({
      kind: "monthly",
      day: 1,
    });
  });

  it("does not call a coincidental same-day pair monthly", () => {
    expect(inferCadence(["2026-01-01", "2026-06-01"])).toEqual({ kind: "everyDays", days: 151 });
  });

  it("survives one nudged date — the majority gap still wins", () => {
    // The real 2026-08-30 shape: one row hand-moved a day early.
    expect(inferCadence(["2026-07-31", "2026-08-14", "2026-08-27", "2026-09-11"])).toEqual({
      kind: "everyDays",
      days: 14,
    });
  });

  it("needs two dates to say anything", () => {
    expect(inferCadence(["2026-09-11"])).toBeNull();
    expect(inferCadence([])).toBeNull();
  });
});

describe("describeCadence", () => {
  it("uses plain words where they exist", () => {
    expect(describeCadence({ kind: "everyDays", days: 14 })).toBe("every 2 weeks");
    expect(describeCadence({ kind: "everyDays", days: 7 })).toBe("weekly");
    expect(describeCadence({ kind: "everyDays", days: 10 })).toBe("every 10 days");
    expect(describeCadence({ kind: "monthly", day: 1 })).toBe("monthly on the 1st");
    expect(describeCadence({ kind: "monthly", day: 22 })).toBe("monthly on the 22nd");
    expect(describeCadence({ kind: "monthly", day: 13 })).toBe("monthly on the 13th");
    expect(describeCadence(null)).toBe("irregular");
  });
});

describe("generateDates", () => {
  it("keeps the anchor's phase when the anchor is in the past", () => {
    expect(
      generateDates({
        anchor: "2026-08-28",
        cadence: { kind: "everyDays", days: 14 },
        from: "2026-09-01",
        through: "2026-10-31",
      }),
    ).toEqual(["2026-09-11", "2026-09-25", "2026-10-09", "2026-10-23"]);
  });

  it("starts at the anchor when the anchor is inside the window", () => {
    expect(
      generateDates({
        anchor: "2026-09-04",
        cadence: { kind: "everyDays", days: 7 },
        from: "2026-09-01",
        through: "2026-09-30",
      }),
    ).toEqual(["2026-09-04", "2026-09-11", "2026-09-18", "2026-09-25"]);
  });

  it("clamps a monthly run to short months", () => {
    expect(
      generateDates({
        anchor: "2026-01-31",
        cadence: { kind: "monthly", day: 31 },
        from: "2026-01-01",
        through: "2026-04-30",
      }),
    ).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("returns nothing for an inverted window", () => {
    expect(
      generateDates({
        anchor: "2026-09-01",
        cadence: { kind: "monthly", day: 1 },
        from: "2026-10-01",
        through: "2026-09-01",
      }),
    ).toEqual([]);
  });
});

describe("planSchedule", () => {
  const base = {
    label: "",
    anchor: "2026-08-28",
    cadence: { kind: "everyDays", days: 14 } as const,
    amountCents: 3974_00,
    from: "2026-08-30",
    through: "2026-10-31",
    today: TODAY,
  };

  it("adds the whole run when nothing exists yet", () => {
    const plan = planSchedule({ ...base, existing: [] });
    expect(plan.entries.map((e) => e.action)).toEqual(["add", "add", "add", "add"]);
    expect(plan.entries.map((e) => e.payDate)).toEqual([
      "2026-09-11",
      "2026-09-25",
      "2026-10-09",
      "2026-10-23",
    ]);
    expect(plan.protectedCount).toBe(0);
  });

  it("is a no-op when the rows already match", () => {
    const existing = ["2026-09-11", "2026-09-25", "2026-10-09", "2026-10-23"].map((d, i) =>
      pay({ id: `p${i}`, payDate: d }),
    );
    expect(planSchedule({ ...base, existing }).entries).toEqual([]);
  });

  it("restates the amount on rows that already sit on the right dates", () => {
    const existing = ["2026-09-11", "2026-09-25"].map((d, i) =>
      pay({ id: `p${i}`, payDate: d, amountCents: 3900_00 }),
    );
    const plan = planSchedule({ ...base, existing, through: "2026-09-30" });
    expect(plan.entries).toEqual([
      {
        action: "update",
        id: "p0",
        payDate: "2026-09-11",
        amountCents: 3974_00,
        fromAmountCents: 3900_00,
      },
      {
        action: "update",
        id: "p1",
        payDate: "2026-09-25",
        amountCents: 3974_00,
        fromAmountCents: 3900_00,
      },
    ]);
  });

  it("MOVES a nudged row back onto cadence instead of deleting and re-adding", () => {
    // Keeping the id matters: the row survives with whatever references it.
    const existing = [pay({ id: "nudged", payDate: "2026-09-10" })];
    const plan = planSchedule({ ...base, existing, through: "2026-09-30" });
    expect(plan.entries).toContainEqual({
      action: "move",
      id: "nudged",
      payDate: "2026-09-11",
      fromPayDate: "2026-09-10",
      amountCents: 3974_00,
    });
    expect(plan.entries.filter((e) => e.action === "add")).toHaveLength(1); // just 09-25
  });

  it("never touches a received or past row, and counts it as protected", () => {
    const existing = [
      pay({ id: "got-it", payDate: "2026-08-28", actualReceived: true, actualDate: "2026-08-27" }),
      pay({ id: "history", payDate: "2026-08-14" }),
    ];
    const plan = planSchedule({ ...base, existing, through: "2026-09-30" });
    expect(plan.protectedCount).toBe(2);
    expect(plan.entries.every((e) => e.payDate >= TODAY)).toBe(true);
    expect(plan.entries.some((e) => "id" in e && (e.id === "got-it" || e.id === "history"))).toBe(
      false,
    );
  });

  it("does not re-add a date a protected row already covers", () => {
    // Payroll posted early and was reconciled against the 09-11 row; the run
    // still wants 09-11, and must not stack a duplicate on top of it.
    const existing = [pay({ id: "early", payDate: "2026-09-11", actualReceived: true })];
    const plan = planSchedule({ ...base, existing, through: "2026-09-20" });
    expect(plan.entries).toEqual([]);
    expect(plan.protectedCount).toBe(1);
  });

  it("only touches its own label", () => {
    const existing = [
      pay({ id: "his", payDate: "2026-09-01", amountCents: 2000_00, note: "Husband" }),
      pay({ id: "hers", payDate: "2026-09-11" }),
    ];
    const plan = planSchedule({ ...base, existing, through: "2026-09-30" });
    expect(plan.entries.some((e) => "id" in e && e.id === "his")).toBe(false);
    expect(plan.protectedCount).toBe(0); // "his" isn't in this sequence at all
  });

  it("leaves extra rows alone by default and removes them only when asked", () => {
    const existing = [
      pay({ id: "keep", payDate: "2026-09-11" }),
      pay({ id: "extra", payDate: "2026-09-18" }),
      pay({ id: "extra2", payDate: "2026-09-19" }),
    ];
    const through = "2026-09-30"; // wants 09-11 and 09-25
    const lenient = planSchedule({ ...base, existing, through });
    // 09-25 is unmatched, so ONE leftover re-spaces into it; the other is left.
    expect(lenient.entries.filter((e) => e.action === "remove")).toHaveLength(0);
    const pruning = planSchedule({ ...base, existing, through, pruneExtra: true });
    expect(pruning.entries.filter((e) => e.action === "remove").map((e) => e.payDate)).toEqual([
      "2026-09-19",
    ]);
  });
});

describe("summarizeSequences", () => {
  it("separates two earners and reads each cadence and amount", () => {
    const rows = [
      // Hers: biweekly $3,974, one already received.
      pay({ id: "h0", payDate: "2026-08-28", actualReceived: true }),
      pay({ id: "h1", payDate: "2026-09-11" }),
      pay({ id: "h2", payDate: "2026-09-25" }),
      pay({ id: "h3", payDate: "2026-10-09" }),
      // His: monthly $2,000 on the 1st.
      pay({ id: "s1", payDate: "2026-09-01", amountCents: 2000_00, note: "Husband" }),
      pay({ id: "s2", payDate: "2026-10-01", amountCents: 2000_00, note: "Husband" }),
      pay({ id: "s3", payDate: "2026-11-01", amountCents: 2000_00, note: "Husband" }),
    ];
    const seqs = summarizeSequences(rows, TODAY);
    expect(seqs).toHaveLength(2);

    // Sorted by next payday: his 09-01 comes before hers 09-11.
    expect(seqs[0]).toMatchObject({
      label: "Husband",
      amountCents: 2000_00,
      cadence: { kind: "monthly", day: 1 },
      upcomingCount: 3,
      settledCount: 0,
      nextPayDate: "2026-09-01",
    });
    expect(seqs[1]).toMatchObject({
      label: "",
      amountCents: 3974_00,
      cadence: { kind: "everyDays", days: 14 },
      upcomingCount: 3,
      settledCount: 1,
      nextPayDate: "2026-09-11",
    });
  });

  it("still reads a sequence whose upcoming rows are too few to infer from", () => {
    const rows = [
      pay({ id: "a", payDate: "2026-08-14", actualReceived: true }),
      pay({ id: "b", payDate: "2026-08-28", actualReceived: true }),
      pay({ id: "c", payDate: "2026-09-11" }),
    ];
    const [seq] = summarizeSequences(rows, TODAY);
    expect(seq!.cadence).toEqual({ kind: "everyDays", days: 14 });
    expect(seq!.upcomingCount).toBe(1);
    expect(seq!.settledCount).toBe(2);
  });

  it("ignores archived rows entirely", () => {
    expect(summarizeSequences([pay({ isActive: false })], TODAY)).toEqual([]);
  });
});
