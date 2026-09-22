import { describe, expect, it } from "vitest";
import {
  billCreateSchema,
  isRealIsoDate,
  isSupportedTimeZone,
  MAX_ABS_CENTS,
  settingsUpdateSchema,
  setupSchema,
} from "./validation";

// Review 2026-09-21 R08: the date validator checked format only, settings
// accepted any timezone string, and money had no bounds.

const settings = {
  startingBalanceCents: 0,
  startingBalanceAsOf: "2026-09-21",
  defaultPaycheckCents: 0,
  firstPaydayDate: "2026-09-25",
  payFrequencyDays: 14,
  projectionMonths: 6,
  currency: "USD",
  timezone: "America/New_York",
};
const bill = {
  name: "Bill",
  category: "Other",
  amountCents: 100,
  intervalMonths: 1,
  anchorDate: "2026-09-01",
};

describe("isRealIsoDate", () => {
  it.each(["2026-09-21", "2028-02-29", "2000-02-29", "2026-12-31", "2026-01-01"])("accepts %s", (d) => {
    expect(isRealIsoDate(d)).toBe(true);
  });
  it.each(["2026-99-99", "2026-02-29", "1900-02-29", "2026-04-31", "2026-00-10", "2026-01-00", "2026-1-01", "20260101"])(
    "rejects %s",
    (d) => {
      expect(isRealIsoDate(d)).toBe(false);
    },
  );
  it("applies to every schema's dates (the review's bill probe)", () => {
    expect(billCreateSchema.safeParse({ ...bill, anchorDate: "2026-99-99" }).success).toBe(false);
    expect(billCreateSchema.safeParse({ ...bill, anchorDate: "2028-02-29" }).success).toBe(true);
  });
});

describe("timezones", () => {
  it("accepts runtime-supported zones and rejects the review's typo", () => {
    expect(isSupportedTimeZone("America/Los_Angeles")).toBe(true);
    expect(isSupportedTimeZone("UTC")).toBe(true);
    expect(isSupportedTimeZone("Mars/Olympus")).toBe(false);
    expect(isSupportedTimeZone("")).toBe(false);
  });
  it("settings and setup refuse an unknown zone before it can be saved", () => {
    expect(settingsUpdateSchema.safeParse(settings).success).toBe(true);
    expect(settingsUpdateSchema.safeParse({ ...settings, timezone: "Mars/Olympus" }).success).toBe(false);
    const setup = setupSchema.safeParse({
      ...settings,
      email: "a@example.com",
      password: "long-enough-pw",
      displayName: "A",
      timezone: "Mars/Olympus",
    });
    expect(setup.success).toBe(false);
  });
});

describe("money bounds", () => {
  it("keeps amounts inside exact integer arithmetic", () => {
    expect(MAX_ABS_CENTS * 1000).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(billCreateSchema.safeParse({ ...bill, amountCents: MAX_ABS_CENTS }).success).toBe(true);
    expect(billCreateSchema.safeParse({ ...bill, amountCents: MAX_ABS_CENTS + 1 }).success).toBe(false);
    expect(billCreateSchema.safeParse({ ...bill, amountCents: Number.MAX_SAFE_INTEGER }).success).toBe(false);
  });
  it("still allows legitimate negative values where the domain does", () => {
    expect(settingsUpdateSchema.safeParse({ ...settings, startingBalanceCents: -250_00 }).success).toBe(true);
    expect(settingsUpdateSchema.safeParse({ ...settings, startingBalanceCents: -MAX_ABS_CENTS - 1 }).success).toBe(false);
  });
});
