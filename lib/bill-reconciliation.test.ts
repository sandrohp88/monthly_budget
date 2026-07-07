import { describe, expect, it } from "vitest";
import {
  draftNamesBill,
  enumerateBillOccurrences,
  matchPaidBillOccurrences,
} from "./bill-reconciliation";

const nvEnergy = {
  id: "bill-nv",
  name: "NV Energy",
  amountCents: 120_00,
  intervalMonths: 1,
  anchorDate: "2026-07-15",
};

function draft(over: Partial<Parameters<typeof matchPaidBillOccurrences>[1][number]> = {}) {
  return {
    id: "txn-1",
    date: "2026-07-03",
    description: "NVENERGY PAYMENTS C/S",
    merchantName: "NV Energy",
    amountCents: 118_37,
    ...over,
  };
}

describe("enumerateBillOccurrences", () => {
  it("generates day-clamped occurrences inside the range", () => {
    expect(
      enumerateBillOccurrences(
        { anchorDate: "2026-01-31", intervalMonths: 1 },
        "2026-02-01",
        "2026-04-30",
      ),
    ).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("respects multi-month intervals", () => {
    expect(
      enumerateBillOccurrences(
        { anchorDate: "2026-01-10", intervalMonths: 3 },
        "2026-01-01",
        "2026-12-31",
      ),
    ).toEqual(["2026-01-10", "2026-04-10", "2026-07-10", "2026-10-10"]);
  });
});

describe("draftNamesBill", () => {
  it("matches through punctuation/case/concatenation", () => {
    expect(draftNamesBill("NV Energy", { description: "NVENERGY PAYMENTS C/S", merchantName: null })).toBe(true);
    expect(draftNamesBill("NV Energy", { description: "AMAZON MKTPLACE", merchantName: "Amazon" })).toBe(false);
  });

  it("refuses to match on very short names", () => {
    expect(draftNamesBill("TV", { description: "TV LICENCE", merchantName: null })).toBe(false);
  });
});

describe("matchPaidBillOccurrences", () => {
  it("settles the July occurrence from a posted payment earlier in the month", () => {
    const matches = matchPaidBillOccurrences([nvEnergy], [draft()]);
    expect(matches).toEqual([
      {
        billId: "bill-nv",
        occurrenceDate: "2026-07-15",
        draftId: "txn-1",
        paidDate: "2026-07-03",
        paidAmountCents: 118_37,
      },
    ]);
  });

  it("settles the nearest occurrence when the payment lands in the prior cycle", () => {
    // June 10 is 5 days from the June 15 occurrence of a monthly bill — it
    // settles June, leaving July pending.
    expect(matchPaidBillOccurrences([nvEnergy], [draft({ date: "2026-06-10" })])).toEqual([
      expect.objectContaining({ occurrenceDate: "2026-06-15" }),
    ]);
  });

  it("rejects drafts outside the date window (multi-month bill)", () => {
    const quarterly = { ...nvEnergy, intervalMonths: 3 };
    // Nearest occurrences to 2026-06-10 are Apr 15 (56d) and Jul 15 (35d) — both > 20d.
    expect(matchPaidBillOccurrences([quarterly], [draft({ date: "2026-06-10" })])).toEqual([]);
  });

  it("rejects amounts outside tolerance", () => {
    // tolerance = max(35% of 120, $25) = $42 → $180 paid is too far off.
    expect(matchPaidBillOccurrences([nvEnergy], [draft({ amountCents: 180_00 })])).toEqual([]);
    // $95 is within $42 of $120.
    expect(matchPaidBillOccurrences([nvEnergy], [draft({ amountCents: 95_00 })])).toHaveLength(1);
  });

  it("rejects refunds/credits (negative amounts)", () => {
    expect(matchPaidBillOccurrences([nvEnergy], [draft({ amountCents: -118_37 })])).toEqual([]);
  });

  it("assigns one-to-one with the nearest occurrence winning", () => {
    // A draft between two monthly occurrences settles the nearer one only.
    const midDraft = draft({ date: "2026-07-28", id: "txn-mid" }); // 13d after Jul 15, 18d before Aug 15
    const matches = matchPaidBillOccurrences([nvEnergy], [midDraft]);
    expect(matches).toEqual([
      expect.objectContaining({ occurrenceDate: "2026-07-15", draftId: "txn-mid" }),
    ]);
  });

  it("two payments settle two adjacent occurrences", () => {
    const matches = matchPaidBillOccurrences(
      [nvEnergy],
      [
        draft({ id: "jul", date: "2026-07-14" }),
        draft({ id: "aug", date: "2026-08-16" }),
      ],
    );
    expect(matches.map((m) => [m.draftId, m.occurrenceDate])).toEqual([
      ["jul", "2026-07-15"],
      ["aug", "2026-08-15"],
    ]);
  });

  it("uses the per-occurrence override amount when present", () => {
    const withOverride = {
      ...nvEnergy,
      overridesByDate: new Map([["2026-07-15", 250_00]]),
    };
    // $240 paid vs $250 planned matches; vs the base $120 it would not.
    expect(
      matchPaidBillOccurrences([withOverride], [draft({ amountCents: 240_00 })]),
    ).toHaveLength(1);
    expect(matchPaidBillOccurrences([nvEnergy], [draft({ amountCents: 240_00 })])).toEqual([]);
  });
});
