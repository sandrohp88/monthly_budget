import { describe, expect, it } from "vitest";
import {
  centsToDollars,
  dollarsToCents,
  formatCents,
  parseMoneyInput,
  sumCents,
} from "./money";

describe("money helpers", () => {
  // ── dollarsToCents ────────────────────────────────────────────────────────
  describe("dollarsToCents", () => {
    it("converts whole dollars precisely", () => {
      expect(dollarsToCents(0)).toBe(0);
      expect(dollarsToCents(1)).toBe(100);
      expect(dollarsToCents(1234)).toBe(123_400);
    });
    it("rounds half-away-from-zero on the decimal digits the user typed", () => {
      // 1.005 must become 101 cents, not 100. The naive `Math.round(x*100)`
      // path drops a cent here because `1.005 * 100 === 100.49999999999999`.
      // Our string-based rounder inspects the third decimal digit directly.
      expect(dollarsToCents(1.005)).toBe(101);
      expect(dollarsToCents(1.0051)).toBe(101);
      expect(dollarsToCents(1.004)).toBe(100);
      expect(dollarsToCents(0.1 + 0.2)).toBe(30);
    });

    it("accepts pre-cleaned strings", () => {
      expect(dollarsToCents("1.005")).toBe(101);
      expect(dollarsToCents("12.34")).toBe(1234);
      expect(dollarsToCents(".5")).toBe(50);
      expect(dollarsToCents("5.")).toBe(500);
      expect(dollarsToCents("0")).toBe(0);
      expect(dollarsToCents("")).toBe(0);
    });

    it("rounds negatives away from zero (commercial rounding)", () => {
      expect(dollarsToCents(-1.005)).toBe(-101);
      expect(dollarsToCents("-1.005")).toBe(-101);
      expect(dollarsToCents(-1.004)).toBe(-100);
    });
    it("handles negative amounts (refunds)", () => {
      expect(dollarsToCents(-12.34)).toBe(-1234);
    });
    it("throws on non-finite inputs", () => {
      expect(() => dollarsToCents(NaN)).toThrow();
      expect(() => dollarsToCents(Infinity)).toThrow();
      expect(() => dollarsToCents(-Infinity)).toThrow();
    });
  });

  // ── centsToDollars ────────────────────────────────────────────────────────
  describe("centsToDollars", () => {
    it("is the inverse of dollarsToCents for safe values", () => {
      expect(centsToDollars(123_400)).toBe(1234);
      expect(centsToDollars(0)).toBe(0);
      expect(centsToDollars(-1234)).toBe(-12.34);
    });
  });

  // ── parseMoneyInput ───────────────────────────────────────────────────────
  describe("parseMoneyInput", () => {
    it("strips dollar signs, commas, and whitespace", () => {
      expect(parseMoneyInput("$1,234.56")).toBe(123_456);
      expect(parseMoneyInput("  $42 ")).toBe(4200);
      expect(parseMoneyInput("1234")).toBe(123_400);
    });
    it("treats empty / sign-only strings as zero", () => {
      expect(parseMoneyInput("")).toBe(0);
      expect(parseMoneyInput("  ")).toBe(0);
      expect(parseMoneyInput("-")).toBe(0);
    });
    it("accepts negatives", () => {
      expect(parseMoneyInput("-12.34")).toBe(-1234);
      expect(parseMoneyInput("-$1,000.00")).toBe(-100_000);
    });
    it("throws on non-numeric input", () => {
      expect(() => parseMoneyInput("abc")).toThrow();
      expect(() => parseMoneyInput("12.34.56")).toThrow();
    });
  });

  // ── formatCents ───────────────────────────────────────────────────────────
  describe("formatCents", () => {
    it("formats USD with two fractional digits", () => {
      expect(formatCents(0)).toBe("$0.00");
      expect(formatCents(123_456)).toBe("$1,234.56");
    });
    it("formats negative as a negative currency string", () => {
      // Intl uses minus-sign; allow both ASCII '-' and Unicode minus.
      expect(formatCents(-1234)).toMatch(/^[-−]\$12\.34$/);
    });
    it("respects the currency code", () => {
      expect(formatCents(100_00, "EUR", "en-US")).toMatch(/100\.00/);
      expect(formatCents(100_00, "EUR", "en-US")).toContain("€");
    });
  });

  // ── sumCents ──────────────────────────────────────────────────────────────
  describe("sumCents", () => {
    it("sums an empty array as zero", () => {
      expect(sumCents([])).toBe(0);
    });
    it("sums positive integers exactly (no float drift)", () => {
      // 100 entries of 13 cents — would drift if we used dollars + multiplied at the end.
      const arr = Array(100).fill(13);
      expect(sumCents(arr)).toBe(1300);
    });
    it("handles a mix of debits and credits", () => {
      expect(sumCents([100, -50, 25, -25])).toBe(50);
    });
  });
});
