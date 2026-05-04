import { describe, expect, it } from "vitest";
import { nextBillOccurrence } from "./bills";

describe("nextBillOccurrence", () => {
  it("advances a monthly historical anchor to the next due date", () => {
    expect(
      nextBillOccurrence({ anchorDate: "2024-01-15", intervalMonths: 1 }, "2026-05-04"),
    ).toBe("2026-05-15");
  });

  it("preserves the interval phase for quarterly bills", () => {
    expect(
      nextBillOccurrence({ anchorDate: "2024-02-10", intervalMonths: 3 }, "2026-05-04"),
    ).toBe("2026-05-10");
  });

  it("clamps month-end anchors when the next month is shorter", () => {
    expect(
      nextBillOccurrence({ anchorDate: "2024-01-31", intervalMonths: 1 }, "2026-02-01"),
    ).toBe("2026-02-28");
  });
});
