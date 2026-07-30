import { describe, expect, it } from "vitest";
import {
  PUSH_RENOTIFY_MS,
  buildInterestPushPayload,
  interestDigest,
  localHourInTimeZone,
  shouldSendInterestPush,
} from "./push-payload";
import type { UncoveredCardDue } from "./projection-insights";

const due = (over: Partial<UncoveredCardDue> = {}): UncoveredCardDue => ({
  cardId: "card-1",
  label: "Chase",
  dueDate: "2026-07-26",
  owedCents: 423_10,
  coverCents: 0,
  shortfallCents: 423_10,
  estimated: false,
  lateCoverCents: 0,
  ...over,
});

describe("interestDigest", () => {
  it("fingerprints card, due date, and shortfall — stable across other fields", () => {
    const a = interestDigest([due(), due({ cardId: "card-2", shortfallCents: 50_00 })]);
    const b = interestDigest([
      due({ label: "Renamed", coverCents: 10_00 }),
      due({ cardId: "card-2", shortfallCents: 50_00, estimated: true }),
    ]);
    expect(a).toBe(b);
  });

  it("changes when a shortfall changes and when a due clears", () => {
    const base = interestDigest([due()]);
    expect(interestDigest([due({ shortfallCents: 400_00 })])).not.toBe(base);
    expect(interestDigest([])).not.toBe(base);
  });

  it("keys an overdue due by its original due date so the digest survives midnight", () => {
    // An overdue marker rides on today, so dueDate moves daily — the digest must not.
    const monday = interestDigest([due({ dueDate: "2026-07-27", overdueSinceDate: "2026-07-20" })]);
    const tuesday = interestDigest([
      due({ dueDate: "2026-07-28", overdueSinceDate: "2026-07-20" }),
    ]);
    expect(monday).toBe(tuesday);
  });
});

describe("buildInterestPushPayload", () => {
  it("returns null with nothing uncovered", () => {
    expect(buildInterestPushPayload([], "USD")).toBeNull();
  });

  it("single due: names the card, amount, and date", () => {
    const p = buildInterestPushPayload([due()], "USD")!;
    expect(p.title).toBe("$423.10 due Jul 26 — no payment planned");
    expect(p.body).toContain("No planned payment covers Chase ($423.10 due Jul 26)");
    expect(p.body).not.toContain("more");
    expect(p).toMatchObject({ url: "/calendar", tag: "interest-alert" });
  });

  it("multiple dues: totals the shortfall and counts the rest", () => {
    const p = buildInterestPushPayload(
      [due(), due({ cardId: "card-2", label: "Citi", shortfallCents: 76_90 })],
      "USD",
    )!;
    expect(p.title).toBe("$500.00 uncovered on 2 cards");
    expect(p.body).toContain("and 1 more");
  });
});

describe("shouldSendInterestPush", () => {
  const base = {
    digest: "card-1:2026-07-26:42310",
    lastDigest: null as string | null,
    lastNotifiedAt: null as number | null,
    nowMs: 1_800_000_000_000,
    localHour: 12,
  };

  it("sends the first time and when the digest changes", () => {
    expect(shouldSendInterestPush(base)).toBe(true);
    expect(
      shouldSendInterestPush({ ...base, lastDigest: "other", lastNotifiedAt: base.nowMs - 1000 }),
    ).toBe(true);
  });

  it("suppresses an unchanged digest until 24h pass", () => {
    const seen = { ...base, lastDigest: base.digest };
    expect(
      shouldSendInterestPush({ ...seen, lastNotifiedAt: base.nowMs - PUSH_RENOTIFY_MS + 1000 }),
    ).toBe(false);
    expect(
      shouldSendInterestPush({ ...seen, lastNotifiedAt: base.nowMs - PUSH_RENOTIFY_MS }),
    ).toBe(true);
  });

  it("never sends during local quiet hours, even for a new digest", () => {
    expect(shouldSendInterestPush({ ...base, localHour: 7 })).toBe(false);
    expect(shouldSendInterestPush({ ...base, localHour: 21 })).toBe(false);
    expect(shouldSendInterestPush({ ...base, localHour: 23 })).toBe(false);
    expect(shouldSendInterestPush({ ...base, localHour: 8 })).toBe(true);
    expect(shouldSendInterestPush({ ...base, localHour: 20 })).toBe(true);
  });
});

describe("localHourInTimeZone", () => {
  it("converts an instant into the zone's hour of day", () => {
    const noonUtc = new Date("2026-07-16T12:00:00Z");
    expect(localHourInTimeZone(noonUtc, "UTC")).toBe(12);
    expect(localHourInTimeZone(noonUtc, "America/New_York")).toBe(8); // EDT = UTC-4
    expect(localHourInTimeZone(noonUtc, "America/Los_Angeles")).toBe(5);
  });

  it("falls back to UTC on an invalid zone instead of throwing", () => {
    const noonUtc = new Date("2026-07-16T12:00:00Z");
    expect(localHourInTimeZone(noonUtc, "Not/AZone")).toBe(12);
  });
});
