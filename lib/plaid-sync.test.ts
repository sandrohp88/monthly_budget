import { describe, expect, it } from "vitest";
// Import the pure helpers directly (no "server-only" sentinel module in this graph).
import { looksLikePaid, toCents } from "./plaid-helpers";

describe("plaid-sync helpers", () => {
  // ── toCents ───────────────────────────────────────────────────────────────
  describe("toCents", () => {
    it("multiplies by 100 and rounds half-away-from-zero", () => {
      expect(toCents(1)).toBe(100);
      expect(toCents(1.234)).toBe(123);
      expect(toCents(1.235)).toBe(124); // .5 rounds up via Math.round
      expect(toCents(0)).toBe(0);
    });
    it("preserves sign for refund-style negative amounts", () => {
      expect(toCents(-12.34)).toBe(-1234);
    });
    it("survives a known floating-point trap (0.1 + 0.2)", () => {
      expect(toCents(0.1 + 0.2)).toBe(30);
    });
  });

  // ── looksLikePaid ─────────────────────────────────────────────────────────
  describe("looksLikePaid", () => {
    const base = {
      lastPaymentDate: "2025-02-08",
      lastPaymentCents: 100_000,
      statementDate: "2025-01-15",
      statementBalanceCents: 100_000,
    };

    it("true: payment on/after statement date AND covers balance", () => {
      expect(looksLikePaid(base)).toBe(true);
    });

    it("true: payment exceeds balance (post-statement charges paid off)", () => {
      expect(looksLikePaid({ ...base, lastPaymentCents: 150_000 })).toBe(true);
    });

    it("false: payment before statement date (prior cycle)", () => {
      expect(looksLikePaid({ ...base, lastPaymentDate: "2025-01-10" })).toBe(false);
    });

    it("false: partial payment", () => {
      expect(looksLikePaid({ ...base, lastPaymentCents: 50_000 })).toBe(false);
    });

    it("false: zero statement balance still requires the Plaid minimum payment", () => {
      expect(
        looksLikePaid({
          ...base,
          statementBalanceCents: 0,
          minimumPaymentCents: 35_00,
          lastPaymentCents: 0,
        }),
      ).toBe(false);
      expect(
        looksLikePaid({
          ...base,
          statementBalanceCents: 0,
          minimumPaymentCents: 35_00,
          lastPaymentCents: 35_00,
        }),
      ).toBe(true);
    });

    it("false: missing payment date", () => {
      expect(looksLikePaid({ ...base, lastPaymentDate: null })).toBe(false);
      expect(looksLikePaid({ ...base, lastPaymentDate: undefined })).toBe(false);
    });

    it("false: missing payment amount", () => {
      expect(looksLikePaid({ ...base, lastPaymentCents: null })).toBe(false);
      expect(looksLikePaid({ ...base, lastPaymentCents: undefined })).toBe(false);
    });

    it("ISO date string comparison handles year boundaries (chronological)", () => {
      expect(
        looksLikePaid({
          ...base,
          statementDate: "2024-12-30",
          lastPaymentDate: "2025-01-05",
        }),
      ).toBe(true);
      expect(
        looksLikePaid({
          ...base,
          statementDate: "2025-01-05",
          lastPaymentDate: "2024-12-30",
        }),
      ).toBe(false);
    });
  });
});
