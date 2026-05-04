import { describe, expect, it } from "vitest";
import {
  computeProjection,
  describeEvents,
  findWorstDay,
  generatePaychecksFromSettings,
  __test__,
  type Bill,
  type ProjectionInput,
} from "./projection";

const baseInput = (): ProjectionInput => ({
  startingBalanceCents: 100_00,
  startDate: "2025-01-01",
  endDate: "2025-12-31",
  paychecks: [],
  bills: [],
  extras: [],
});

describe("projection engine", () => {
  it("empty inputs carry the starting balance forward unchanged", () => {
    const input: ProjectionInput = {
      ...baseInput(),
      startDate: "2025-03-01",
      endDate: "2025-03-05",
      startingBalanceCents: 12345,
    };
    const rows = computeProjection(input);
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.incomeCents).toBe(0);
      expect(r.expenseCents).toBe(0);
      expect(r.balanceCents).toBe(12345);
      expect(r.events).toHaveLength(0);
    }
  });

  it("monthly bill on day 15 fires every month within the window, never twice", () => {
    const bill: Bill = {
      id: "b1",
      name: "Rent",
      amountCents: 100_00,
      intervalMonths: 1,
      anchorDate: "2024-01-15",
    };
    const rows = computeProjection({ ...baseInput(), bills: [bill] });
    const billDays = rows.filter((r) => r.events.some((e) => e.label === "Rent"));
    expect(billDays).toHaveLength(12);
    const months = new Set(billDays.map((r) => r.date.slice(0, 7)));
    expect(months.size).toBe(12);
    for (const r of billDays) {
      expect(r.date.endsWith("-15")).toBe(true);
      expect(r.events.filter((e) => e.label === "Rent")).toHaveLength(1);
    }
  });

  it("annual bill on Jul 15 fires only in July across multi-year windows", () => {
    const bill: Bill = {
      id: "b2",
      name: "Domain renewal",
      amountCents: 20_00,
      intervalMonths: 12,
      anchorDate: "2024-07-15",
    };
    const rows = computeProjection({
      ...baseInput(),
      startDate: "2024-01-01",
      endDate: "2026-12-31",
      bills: [bill],
    });
    const hits = rows.filter((r) => r.events.some((e) => e.label === "Domain renewal"));
    expect(hits.map((r) => r.date)).toEqual(["2024-07-15", "2025-07-15", "2026-07-15"]);
  });

  it("annual bill with anchor day 31 in Feb clamps to last day of February", () => {
    // Anchor is "2024-02-29" (the natural Feb-31 clamp in a leap year).
    // The engine should remember the *intended* day-of-month — but since
    // we already clamped at backfill, day=29 is what's stored. Across
    // non-leap years, that lands on Feb 28 (clamp) and Feb 29 in the leap year.
    const bill: Bill = {
      id: "b3",
      name: "Edge bill",
      amountCents: 1_00,
      intervalMonths: 12,
      anchorDate: "2024-02-29",
    };
    const rows = computeProjection({
      ...baseInput(),
      startDate: "2023-01-01",
      endDate: "2025-12-31",
      bills: [bill],
    });
    const hits = rows.filter((r) => r.events.some((e) => e.label === "Edge bill"));
    expect(hits.map((r) => r.date)).toEqual([
      "2023-02-28",
      "2024-02-29",
      "2025-02-28",
    ]);
  });

  it("monthly bill with anchor day 31 clamps in 30-day months and February", () => {
    const bill: Bill = {
      id: "b4",
      name: "Last day",
      amountCents: 1_00,
      intervalMonths: 1,
      anchorDate: "2024-01-31",
    };
    const rows = computeProjection({
      ...baseInput(),
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      bills: [bill],
    });
    const hits = rows.filter((r) => r.events.some((e) => e.label === "Last day"));
    expect(hits.map((r) => r.date)).toEqual([
      "2024-01-31",
      "2024-02-29",
      "2024-03-31",
      "2024-04-30",
      "2024-05-31",
      "2024-06-30",
      "2024-07-31",
      "2024-08-31",
      "2024-09-30",
      "2024-10-31",
      "2024-11-30",
      "2024-12-31",
    ]);
  });

  it("quarterly bill (intervalMonths=3) fires four times per year", () => {
    const bill: Bill = {
      id: "bq",
      name: "Insurance",
      amountCents: 300_00,
      intervalMonths: 3,
      anchorDate: "2025-02-10",
    };
    const rows = computeProjection({
      ...baseInput(),
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      bills: [bill],
    });
    const hits = rows.filter((r) => r.events.some((e) => e.label === "Insurance"));
    expect(hits.map((r) => r.date)).toEqual([
      "2025-02-10",
      "2025-05-10",
      "2025-08-10",
      "2025-11-10",
    ]);
  });

  it("semiannual bill (intervalMonths=6) generates backward from a future anchor", () => {
    // Anchor is in the future relative to the projection window — engine must
    // walk backward by the interval to find occurrences in-window.
    const bill: Bill = {
      id: "bs",
      name: "Property tax",
      amountCents: 1500_00,
      intervalMonths: 6,
      anchorDate: "2026-09-01",
    };
    const rows = computeProjection({
      ...baseInput(),
      startDate: "2024-01-01",
      endDate: "2026-12-31",
      bills: [bill],
    });
    const hits = rows.filter((r) => r.events.some((e) => e.label === "Property tax"));
    expect(hits.map((r) => r.date)).toEqual([
      "2024-03-01",
      "2024-09-01",
      "2025-03-01",
      "2025-09-01",
      "2026-03-01",
      "2026-09-01",
    ]);
  });

  it("every-2-months bill aligns to anchor day-of-month across odd intervals", () => {
    const bill: Bill = {
      id: "b2m",
      name: "Gym",
      amountCents: 75_00,
      intervalMonths: 2,
      anchorDate: "2025-03-20",
    };
    const rows = computeProjection({
      ...baseInput(),
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      bills: [bill],
    });
    const hits = rows.filter((r) => r.events.some((e) => e.label === "Gym"));
    expect(hits.map((r) => r.date)).toEqual([
      "2025-01-20",
      "2025-03-20",
      "2025-05-20",
      "2025-07-20",
      "2025-09-20",
      "2025-11-20",
    ]);
  });

  it("paycheck and bill on the same day: paycheck applied first, balance reflects both", () => {
    const rows = computeProjection({
      ...baseInput(),
      startDate: "2025-06-01",
      endDate: "2025-06-02",
      startingBalanceCents: 0,
      paychecks: [{ payDate: "2025-06-01", amountCents: 1000_00 }],
      bills: [
        {
          id: "b",
          name: "Rent",
          amountCents: 700_00,
          intervalMonths: 1,
          anchorDate: "2024-01-01",
        },
      ],
    });
    const day = rows[0]!;
    expect(day.events.map((e) => e.kind)).toEqual(["paycheck", "bill"]);
    expect(day.incomeCents).toBe(1000_00);
    expect(day.expenseCents).toBe(700_00);
    expect(day.balanceCents).toBe(300_00);
  });

  it("uses a bill payment override for one generated occurrence only", () => {
    const rows = computeProjection({
      ...baseInput(),
      startDate: "2025-01-01",
      endDate: "2025-03-31",
      startingBalanceCents: 1000_00,
      bills: [
        {
          id: "rent",
          name: "Rent",
          amountCents: 700_00,
          intervalMonths: 1,
          anchorDate: "2025-01-15",
          paymentOverrides: [{ date: "2025-02-15", amountCents: 400_00 }],
        },
      ],
    });

    const jan = rows.find((r) => r.date === "2025-01-15")!;
    const feb = rows.find((r) => r.date === "2025-02-15")!;
    const mar = rows.find((r) => r.date === "2025-03-15")!;

    expect(jan.expenseCents).toBe(700_00);
    expect(feb.expenseCents).toBe(400_00);
    expect(feb.events[0]).toMatchObject({
      sourceId: "rent",
      amountCents: 400_00,
      originalAmountCents: 700_00,
    });
    expect(mar.expenseCents).toBe(700_00);
  });

  it("negative balances are produced correctly", () => {
    const rows = computeProjection({
      ...baseInput(),
      startDate: "2025-01-01",
      endDate: "2025-01-03",
      startingBalanceCents: 50_00,
      bills: [],
      extras: [{ date: "2025-01-02", description: "Surprise", amountCents: 200_00 }],
    });
    expect(rows[0]!.balanceCents).toBe(50_00);
    expect(rows[1]!.balanceCents).toBe(-150_00);
    expect(rows[2]!.balanceCents).toBe(-150_00);
  });

  it("extras hit on the right date and combine with bills", () => {
    const rows = computeProjection({
      ...baseInput(),
      startDate: "2025-04-10",
      endDate: "2025-04-12",
      startingBalanceCents: 1000_00,
      bills: [
        {
          id: "b",
          name: "Internet",
          amountCents: 60_00,
          intervalMonths: 1,
          anchorDate: "2024-01-11",
        },
      ],
      extras: [{ date: "2025-04-11", description: "Concert tickets", amountCents: 90_00 }],
    });
    const day = rows[1]!;
    expect(day.date).toBe("2025-04-11");
    expect(day.events).toHaveLength(2);
    expect(day.events.map((e) => e.kind)).toEqual(["bill", "extra"]);
    expect(day.expenseCents).toBe(150_00);
    expect(day.balanceCents).toBe(850_00);
    expect(describeEvents(day.events)).toBe("Internet + Concert tickets");
  });

  it("carries adjustment metadata for credit card payment estimate extras", () => {
    const rows = computeProjection({
      ...baseInput(),
      startDate: "2025-04-10",
      endDate: "2025-04-10",
      startingBalanceCents: 1000_00,
      bills: [],
      extras: [
        {
          date: "2025-04-10",
          description: "Card next payment (est)",
          amountCents: 250_00,
          sourceId: "card-1",
          sourceType: "creditCardPayment",
          originalAmountCents: 600_00,
          paymentDueCents: 250_00,
          paymentBalanceCents: 1_000_00,
        },
      ],
    });

    expect(rows[0]!.events[0]).toMatchObject({
      kind: "extra",
      label: "Card next payment (est)",
      amountCents: 250_00,
      sourceId: "card-1",
      sourceType: "creditCardPayment",
      originalAmountCents: 600_00,
      paymentDueCents: 250_00,
      paymentBalanceCents: 1_000_00,
    });
  });

  it("12-month window produces exactly the right number of daily rows", () => {
    const rows = computeProjection({
      ...baseInput(),
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });
    expect(rows).toHaveLength(365);

    const leapRows = computeProjection({
      ...baseInput(),
      startDate: "2024-01-01",
      endDate: "2024-12-31",
    });
    expect(leapRows).toHaveLength(366);

    const dates = new Set(rows.map((r) => r.date));
    expect(dates.size).toBe(365);
    expect(rows[0]!.date).toBe("2025-01-01");
    expect(rows[rows.length - 1]!.date).toBe("2025-12-31");
  });

  it("DST boundaries do not affect day count or day labels", () => {
    // US DST spring-forward: 2025-03-09; fall-back: 2025-11-02
    const rows = computeProjection({
      ...baseInput(),
      startDate: "2025-03-08",
      endDate: "2025-03-10",
    });
    expect(rows.map((r) => r.date)).toEqual(["2025-03-08", "2025-03-09", "2025-03-10"]);

    const rows2 = computeProjection({
      ...baseInput(),
      startDate: "2025-11-01",
      endDate: "2025-11-03",
    });
    expect(rows2.map((r) => r.date)).toEqual(["2025-11-01", "2025-11-02", "2025-11-03"]);

    // Year-long span across both DST boundaries still yields 365 rows
    const fullYear = computeProjection({
      ...baseInput(),
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });
    expect(fullYear).toHaveLength(365);
  });

  it("paycheck event uses provided note as label, falling back to 'Paycheck'", () => {
    const rows = computeProjection({
      ...baseInput(),
      startDate: "2025-05-01",
      endDate: "2025-05-02",
      startingBalanceCents: 0,
      paychecks: [
        { payDate: "2025-05-01", amountCents: 500_00, note: "Bonus" },
        { payDate: "2025-05-02", amountCents: 500_00, note: "" },
      ],
    });
    expect(rows[0]!.events[0]!.label).toBe("Bonus");
    expect(rows[1]!.events[0]!.label).toBe("Paycheck");
  });

  it("findWorstDay returns the row with the lowest balance", () => {
    const rows = computeProjection({
      ...baseInput(),
      startDate: "2025-01-01",
      endDate: "2025-01-04",
      startingBalanceCents: 100_00,
      extras: [
        { date: "2025-01-02", description: "x", amountCents: 50_00 },
        { date: "2025-01-03", description: "y", amountCents: 100_00 },
        { date: "2025-01-04", description: "z", amountCents: -60_00 }, // refund-like
      ],
    });
    const worst = findWorstDay(rows);
    expect(worst?.date).toBe("2025-01-03");
    expect(worst?.balanceCents).toBe(-50_00);
  });

  it("internal helpers handle clamping and parsing edge cases", () => {
    expect(__test__.daysInMonth(2024, 2)).toBe(29);
    expect(__test__.daysInMonth(2025, 2)).toBe(28);
    expect(__test__.daysInMonth(2025, 4)).toBe(30);
    expect(__test__.clampedBillDate(2025, 2, 31)).toBe("2025-02-28");
    expect(__test__.clampedBillDate(2024, 2, 31)).toBe("2024-02-29");
    expect(__test__.formatIsoDate(__test__.parseIsoDate("2025-07-04"))).toBe("2025-07-04");
    expect(() => __test__.parseIsoDate("not-a-date")).toThrow();
  });

  // ── describeEvents ────────────────────────────────────────────────────────
  describe("describeEvents", () => {
    it("returns an empty string for no events", () => {
      expect(describeEvents([])).toBe("");
    });
    it("joins event labels with ' + '", () => {
      expect(
        describeEvents([
          { kind: "paycheck", label: "Paycheck", amountCents: 100_000 },
          { kind: "bill", label: "Rent", amountCents: 50_000 },
        ]),
      ).toBe("Paycheck + Rent");
    });
  });

  // ── generatePaychecksFromSettings ─────────────────────────────────────────
  describe("generatePaychecksFromSettings", () => {
    it("emits paychecks at the requested cadence starting on firstPayday", () => {
      const out = generatePaychecksFromSettings({
        firstPayday: "2025-01-03",
        frequencyDays: 14,
        months: 1,
        defaultAmountCents: 200_000,
      });
      // months=1 → window of 1*31 days. With 14-day cadence, that emits 3
      // dates: Jan 3, Jan 17, Jan 31. Pin behavior so a refactor can't
      // silently change cadence math.
      expect(out.map((p) => p.payDate)).toEqual(["2025-01-03", "2025-01-17", "2025-01-31"]);
      expect(out.every((p) => p.amountCents === 200_000)).toBe(true);
    });

    it("returns just the first paycheck when frequency exceeds the window", () => {
      const out = generatePaychecksFromSettings({
        firstPayday: "2025-01-03",
        frequencyDays: 60,
        months: 1, // window ≈ 31 days, less than one cadence
        defaultAmountCents: 100_000,
      });
      expect(out).toHaveLength(1);
      expect(out[0]?.payDate).toBe("2025-01-03");
    });
  });
});
