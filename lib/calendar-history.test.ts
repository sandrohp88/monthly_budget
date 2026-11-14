import { describe, expect, it } from "vitest";
import { groupCalendarHistory, type CalendarHistoryItem } from "./calendar-history";

const item = (
  partial: Partial<CalendarHistoryItem> & Pick<CalendarHistoryItem, "id" | "date" | "amountCents">,
): CalendarHistoryItem => ({
  description: partial.description ?? `tx-${partial.id}`,
  ...partial,
});

describe("groupCalendarHistory", () => {
  const startDate = "2026-11-14";

  it("returns an empty Map when there are no items", () => {
    expect(groupCalendarHistory([], startDate).size).toBe(0);
  });

  it("excludes items dated on or after the projection start date", () => {
    const items = [
      item({ id: "a", date: "2026-11-13", amountCents: 100, description: "Before" }),
      item({ id: "b", date: startDate, amountCents: 200, description: "On start" }),
      item({ id: "c", date: "2026-11-15", amountCents: 300, description: "After" }),
    ];
    const days = groupCalendarHistory(items, startDate);
    expect([...days.keys()]).toEqual(["2026-11-13"]);
    expect(days.get("2026-11-13")!.items.map((i) => i.id)).toEqual(["a"]);
  });

  it("groups by date and totals money in / money out", () => {
    const items = [
      item({ id: "out1", date: "2026-11-10", amountCents: 5_00, description: "Coffee" }),
      item({ id: "in1", date: "2026-11-10", amountCents: -20_00, description: "Refund" }),
      item({ id: "out2", date: "2026-11-10", amountCents: 1_00, description: "Snack" }),
      item({ id: "other", date: "2026-11-09", amountCents: 9_00, description: "Other" }),
    ];
    const day = groupCalendarHistory(items, startDate).get("2026-11-10")!;
    expect(day.moneyInCents).toBe(20_00);
    expect(day.moneyOutCents).toBe(6_00);
    expect(day.items.map((i) => i.id)).toEqual(["in1", "out1", "out2"]);
  });

  it("sorts within a day by absolute amount descending, then description", () => {
    const items = [
      item({ id: "1", date: "2026-11-10", amountCents: 10_00, description: "Zebra" }),
      item({ id: "2", date: "2026-11-10", amountCents: -10_00, description: "Apple" }),
      item({ id: "3", date: "2026-11-10", amountCents: 50_00, description: "Big" }),
      item({ id: "4", date: "2026-11-10", amountCents: 10_00, description: "Mango" }),
    ];
    const ids = groupCalendarHistory(items, startDate)
      .get("2026-11-10")!
      .items.map((i) => i.id);
    // 50 first; then the two ±1000 sorted by description (Apple before Mango/Zebra).
    expect(ids).toEqual(["3", "2", "4", "1"]);
  });

  it("ignores zero-amount rows in the money totals", () => {
    const items = [
      item({ id: "z", date: "2026-11-10", amountCents: 0, description: "Zero" }),
      item({ id: "o", date: "2026-11-10", amountCents: 3_00, description: "Out" }),
    ];
    const day = groupCalendarHistory(items, startDate).get("2026-11-10")!;
    expect(day.moneyInCents).toBe(0);
    expect(day.moneyOutCents).toBe(3_00);
    expect(day.items).toHaveLength(2);
  });
});
