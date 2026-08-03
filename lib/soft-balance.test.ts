import { describe, expect, it } from "vitest";
import { showsPostedBalance } from "./soft-balance";

const row = (date: string, balanceCents: number, postedBalanceCents: number) => ({
  date,
  balanceCents,
  postedBalanceCents,
});

describe("showsPostedBalance", () => {
  const today = "2026-08-03";

  it("shows the pair on a past day with cash in flight", () => {
    expect(showsPostedBalance(row("2026-08-01", 6_789_16, 10_817_16), today)).toBe(true);
  });

  it("shows the pair on today itself", () => {
    expect(showsPostedBalance(row(today, 6_789_16, 10_817_16), today)).toBe(true);
  });

  it("hides it on a future day even though the series still differ", () => {
    // The gap is real arithmetic — every in-flight item is dated today or
    // earlier, so it carries forward forever — but rendering it tomorrow would
    // suggest a payment already in flight might never land.
    expect(showsPostedBalance(row("2026-08-04", 6_789_16, 10_817_16), today)).toBe(false);
  });

  it("hides it when nothing is in flight", () => {
    expect(showsPostedBalance(row("2026-08-01", 10_817_16, 10_817_16), today)).toBe(false);
  });
});
