import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addDaysIso,
  daysBetween,
  endOfMonthsAhead,
  formatIso,
  startOfMonthIso,
  todayIso,
} from "./dates";

describe("dates", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── todayIso ──────────────────────────────────────────────────────────────
  describe("todayIso", () => {
    it("returns the date in the configured timezone, not UTC", () => {
      // 2025-03-15 03:30 UTC == 2025-03-14 23:30 America/New_York
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-03-15T03:30:00Z"));
      expect(todayIso("America/New_York")).toBe("2025-03-14");
      expect(todayIso("UTC")).toBe("2025-03-15");
    });

    it("handles a DST forward transition (2025-03-09 01:30 UTC)", () => {
      // At 01:30 UTC the US east coast is still on EST (Mar 9 starts in DST at 07:00 UTC).
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-03-09T01:30:00Z"));
      expect(todayIso("America/New_York")).toBe("2025-03-08");
    });

    it("handles a DST backward transition (2025-11-02 06:30 UTC)", () => {
      // 06:30 UTC == 02:30 EDT == 01:30 EST after fall-back. Day stays Nov 2.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-11-02T06:30:00Z"));
      expect(todayIso("America/New_York")).toBe("2025-11-02");
    });
  });

  // ── addDaysIso ────────────────────────────────────────────────────────────
  describe("addDaysIso", () => {
    it("adds positive days, crossing month and year boundaries", () => {
      expect(addDaysIso("2025-01-30", 5)).toBe("2025-02-04");
      expect(addDaysIso("2024-12-30", 5)).toBe("2025-01-04");
    });
    it("subtracts when given a negative count", () => {
      expect(addDaysIso("2025-03-01", -1)).toBe("2025-02-28");
      expect(addDaysIso("2024-03-01", -1)).toBe("2024-02-29"); // leap year
    });
    it("returns the same day when adding 0", () => {
      expect(addDaysIso("2025-06-15", 0)).toBe("2025-06-15");
    });
  });

  // ── daysBetween ───────────────────────────────────────────────────────────
  describe("daysBetween", () => {
    it("counts forward and backward correctly", () => {
      expect(daysBetween("2025-01-01", "2025-01-08")).toBe(7);
      expect(daysBetween("2025-01-08", "2025-01-01")).toBe(-7);
    });
    it("returns 0 for the same date", () => {
      expect(daysBetween("2025-06-15", "2025-06-15")).toBe(0);
    });
    it("counts a leap year correctly", () => {
      expect(daysBetween("2024-01-01", "2025-01-01")).toBe(366);
      expect(daysBetween("2025-01-01", "2026-01-01")).toBe(365);
    });
  });

  // ── endOfMonthsAhead ──────────────────────────────────────────────────────
  describe("endOfMonthsAhead", () => {
    it("returns the last day of the target month, regardless of input day", () => {
      expect(endOfMonthsAhead("2025-01-15", 0)).toBe("2025-01-31");
      expect(endOfMonthsAhead("2025-01-01", 1)).toBe("2025-02-28");
      expect(endOfMonthsAhead("2024-01-01", 1)).toBe("2024-02-29");
      expect(endOfMonthsAhead("2025-01-01", 3)).toBe("2025-04-30");
    });
    it("crosses year boundaries", () => {
      expect(endOfMonthsAhead("2025-11-15", 2)).toBe("2026-01-31");
    });
  });

  // ── startOfMonthIso ──────────────────────────────────────────────────────
  describe("startOfMonthIso", () => {
    it("returns the first day of the containing month", () => {
      expect(startOfMonthIso("2026-05-04")).toBe("2026-05-01");
      expect(startOfMonthIso("2026-12-31")).toBe("2026-12-01");
    });
  });

  // ── formatIso ─────────────────────────────────────────────────────────────
  describe("formatIso", () => {
    it('returns the iso string verbatim for fmt="iso"', () => {
      expect(formatIso("2025-06-15", "iso")).toBe("2025-06-15");
    });
    it('produces a long human label by default', () => {
      // We pin only the shape, not locale-sensitive month names beyond English.
      const long = formatIso("2025-06-15");
      expect(long).toMatch(/2025/);
      expect(long).toMatch(/Jun/);
      expect(long).toMatch(/15/);
    });
    it('produces a short label without year', () => {
      const short = formatIso("2025-06-15", "short");
      expect(short).toMatch(/Jun/);
      expect(short).toMatch(/15/);
      expect(short).not.toMatch(/2025/);
    });
  });
});
