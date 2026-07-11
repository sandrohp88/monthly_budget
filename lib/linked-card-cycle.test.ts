import { describe, expect, it } from "vitest";
import { inferLinkedCardCycle } from "./linked-card-cycle";

describe("inferLinkedCardCycle", () => {
  it("uses the median observed statement interval and latest statement anchor", () => {
    expect(
      inferLinkedCardCycle({
        statementDates: ["2026-01-10", "2026-02-09", "2026-03-12", "2026-04-11"],
        paymentDates: [],
        gracePeriodDays: 21,
      }),
    ).toEqual({ anchorDate: "2026-04-11", intervalDays: 30, source: "statements" });
  });

  it("falls back to payment cadence while keeping a known statement anchor", () => {
    expect(
      inferLinkedCardCycle({
        statementDates: ["2026-04-15"],
        paymentDates: ["2026-02-05", "2026-03-07", "2026-04-06"],
        gracePeriodDays: 21,
      }),
    ).toEqual({ anchorDate: "2026-04-15", intervalDays: 30, source: "payments" });
  });

  it("derives a fallback statement anchor from the latest recurring payment", () => {
    expect(
      inferLinkedCardCycle({
        statementDates: [],
        paymentDates: ["2026-02-20", "2026-03-22", "2026-04-21"],
        gracePeriodDays: 21,
      }),
    ).toEqual({ anchorDate: "2026-03-31", intervalDays: 30, source: "payments" });
  });

  it("ignores implausible gaps and requires at least two observations", () => {
    expect(
      inferLinkedCardCycle({
        statementDates: ["2026-04-15"],
        paymentDates: ["2026-01-01", "2026-01-10", "2026-04-01"],
        gracePeriodDays: 21,
      }),
    ).toBeNull();
  });
});
