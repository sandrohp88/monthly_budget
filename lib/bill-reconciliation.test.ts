import { describe, expect, it } from "vitest";
import {
  billAliasList,
  draftNamesBill,
  enumerateBillOccurrences,
  findExternallyPaidOccurrences,
  findHeldOccurrences,
  findUnpaidRecentOccurrences,
  matchAllocatedObligations,
  matchPaidBillOccurrences,
  occurrenceKey,
  type BillPaymentMark,
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

describe("billAliasList", () => {
  it("splits on commas, trims, and drops too-short entries", () => {
    expect(billAliasList("ACME PROPERTY MGMT,  SPPC 8841 , tv, ")).toEqual([
      "ACME PROPERTY MGMT",
      "SPPC 8841",
    ]);
  });

  it("returns empty for null/undefined/blank", () => {
    expect(billAliasList(null)).toEqual([]);
    expect(billAliasList(undefined)).toEqual([]);
    expect(billAliasList("  ")).toEqual([]);
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
        draftIds: ["txn-1"],
        paidDate: "2026-07-03",
        paidAmountCents: 118_37,
      },
    ]);
  });

  it("keeps two same-day bills (two houses) separate by best amount fit", () => {
    // Two NV Energy bills, one per house, both due the 1st, estimates $130/$70.
    // The utility posts two indistinguishable-by-name pulls ($120.61/$61.31);
    // each must settle its own house by amount, not sum onto one.
    const houseA = { id: "nv-a", name: "NV Energy", amountCents: 130_00, intervalMonths: 1, anchorDate: "2026-07-01" };
    const houseB = { id: "nv-b", name: "NV Energy", amountCents: 70_00, intervalMonths: 1, anchorDate: "2026-07-01" };
    const matches = matchPaidBillOccurrences(
      [houseA, houseB],
      [
        draft({ id: "big", date: "2026-07-02", amountCents: 120_61, description: "NV Energy" }),
        draft({ id: "small", date: "2026-07-02", amountCents: 61_31, description: "NV Energy" }),
      ],
    );
    expect(matches).toEqual([
      expect.objectContaining({ billId: "nv-a", draftIds: ["big"], paidAmountCents: 120_61 }),
      expect.objectContaining({ billId: "nv-b", draftIds: ["small"], paidAmountCents: 61_31 }),
    ]);
  });

  it("sums several partial pulls into one settlement (real NV Energy shape)", () => {
    // Prod shape: bill planned $300 due the 1st; the utility posts two ACH
    // pulls (North + South) of ~$120 + ~$61 on the 2nd. Individually each is
    // far from $300 — together they clear the settle fraction.
    const bill = { ...nvEnergy, amountCents: 300_00, anchorDate: "2026-07-01" };
    const matches = matchPaidBillOccurrences(
      [bill],
      [
        draft({ id: "north", date: "2026-07-02", amountCents: 120_61, description: "Withdrawal Ach Nv Energy North Type: Sppc" }),
        draft({ id: "south", date: "2026-07-02", amountCents: 61_31, description: "NV Energy" }),
      ],
    );
    expect(matches).toEqual([
      {
        billId: "bill-nv",
        occurrenceDate: "2026-07-01",
        draftIds: ["north", "south"],
        paidDate: "2026-07-02",
        paidAmountCents: 181_92,
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

  it("does not settle when the posted total is a tiny fraction of the plan", () => {
    // $30 posted vs $300 planned (10%) < SETTLE_MIN_FRACTION.
    const bill = { ...nvEnergy, amountCents: 300_00 };
    expect(matchPaidBillOccurrences([bill], [draft({ amountCents: 30_00 })])).toEqual([]);
  });

  it("over-payment settles (planned amounts are estimates)", () => {
    expect(matchPaidBillOccurrences([nvEnergy], [draft({ amountCents: 180_00 })])).toEqual([
      expect.objectContaining({ paidAmountCents: 180_00 }),
    ]);
  });

  it("rejects refunds/credits (negative amounts)", () => {
    expect(matchPaidBillOccurrences([nvEnergy], [draft({ amountCents: -118_37 })])).toEqual([]);
  });

  it("assigns each draft to its nearest occurrence only", () => {
    // A draft between two monthly occurrences settles the nearer one only.
    const midDraft = draft({ date: "2026-07-28", id: "txn-mid" }); // 13d after Jul 15, 18d before Aug 15
    const matches = matchPaidBillOccurrences([nvEnergy], [midDraft]);
    expect(matches).toEqual([
      expect.objectContaining({ occurrenceDate: "2026-07-15", draftIds: ["txn-mid"] }),
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
    expect(matches.map((m) => [m.draftIds, m.occurrenceDate])).toEqual([
      [["jul"], "2026-07-15"],
      [["aug"], "2026-08-15"],
    ]);
  });

  it("manual link matches a bill whose name never appears in the draft text", () => {
    // Two houses split into two bills. The bank posts both pulls under the
    // same wording, so "NV Energy North House" can't match by name — the
    // manual link assigns it anyway.
    const northHouse = { id: "nv-north", name: "NV Energy North House", amountCents: 120_00, intervalMonths: 1, anchorDate: "2026-07-01" };
    const matches = matchPaidBillOccurrences(
      [northHouse],
      [draft({ id: "north", date: "2026-07-02", amountCents: 120_61, linkedBillId: "nv-north" })],
    );
    expect(matches).toEqual([
      expect.objectContaining({ billId: "nv-north", draftIds: ["north"], paidAmountCents: 120_61 }),
    ]);
  });

  it("manual link keeps two same-descriptor payments on their own bills", () => {
    // Both pulls post as "NV Energy"; only bill A matches by name. Without
    // links, phase 2 would fold both onto A. Linking each pull pins it.
    const houseA = { id: "nv-a", name: "NV Energy", amountCents: 130_00, intervalMonths: 1, anchorDate: "2026-07-01" };
    const houseB = { id: "nv-b", name: "NV Energy Second House", amountCents: 70_00, intervalMonths: 1, anchorDate: "2026-07-01" };
    const matches = matchPaidBillOccurrences(
      [houseA, houseB],
      [
        draft({ id: "big", date: "2026-07-02", amountCents: 120_61, description: "NV Energy", linkedBillId: "nv-a" }),
        draft({ id: "small", date: "2026-07-02", amountCents: 61_31, description: "NV Energy", linkedBillId: "nv-b" }),
      ],
    );
    expect(matches).toEqual([
      expect.objectContaining({ billId: "nv-a", draftIds: ["big"] }),
      expect.objectContaining({ billId: "nv-b", draftIds: ["small"] }),
    ]);
  });

  it("a linked draft wins its occurrence over a closer-amount heuristic draft", () => {
    const bill = { ...nvEnergy, anchorDate: "2026-07-01" };
    const matches = matchPaidBillOccurrences(
      [bill],
      [
        // Heuristic draft is a perfect amount fit; the linked one is not —
        // the user's assignment still takes the occurrence.
        draft({ id: "heuristic", date: "2026-07-02", amountCents: 120_00 }),
        draft({ id: "pinned", date: "2026-07-02", amountCents: 90_00, description: "ACH WITHDRAWAL 8841", linkedBillId: "bill-nv" }),
      ],
    );
    expect(matches[0]).toEqual(
      expect.objectContaining({ billId: "bill-nv", draftIds: ["heuristic", "pinned"] }),
    );
    // pinned holds the phase-1 slot; the heuristic draft folds in via phase 2.
  });

  it("a draft linked to an unknown bill matches nothing (no heuristic fallback)", () => {
    const matches = matchPaidBillOccurrences(
      [nvEnergy],
      [draft({ linkedBillId: "archived-bill" })],
    );
    expect(matches).toEqual([]);
  });

  it("learned aliases match future months' identically-worded drafts", () => {
    // Last month the user linked "ACH WITHDRAWAL SPPC 8841" to the bill; this
    // month's draft posts the same wording and matches without a new link.
    const bill = { id: "nv-north", name: "NV Energy North House", amountCents: 120_00, intervalMonths: 1, anchorDate: "2026-07-01" };
    const matches = matchPaidBillOccurrences(
      [bill],
      [draft({ id: "aug", date: "2026-08-02", amountCents: 118_00, description: "ACH WITHDRAWAL SPPC 8841", merchantName: null })],
      { aliasesByBill: new Map([["nv-north", ["ACH WITHDRAWAL SPPC 8841"]]]) },
    );
    expect(matches).toEqual([
      expect.objectContaining({ billId: "nv-north", occurrenceDate: "2026-08-01", draftIds: ["aug"] }),
    ]);
  });

  it("aliases on both bills let amount fit split same-descriptor twins", () => {
    // Both houses' pulls post identically; after one manual link each, both
    // bills carry the alias — phase 1 best-amount-fit splits them correctly.
    const houseA = { id: "nv-a", name: "House A Power", amountCents: 130_00, intervalMonths: 1, anchorDate: "2026-08-01" };
    const houseB = { id: "nv-b", name: "House B Power", amountCents: 70_00, intervalMonths: 1, anchorDate: "2026-08-01" };
    const aliases = new Map([
      ["nv-a", ["NVENERGY PAYMENTS C/S"]],
      ["nv-b", ["NVENERGY PAYMENTS C/S"]],
    ]);
    const matches = matchPaidBillOccurrences(
      [houseA, houseB],
      [
        draft({ id: "big", date: "2026-08-02", amountCents: 120_61, merchantName: null }),
        draft({ id: "small", date: "2026-08-02", amountCents: 61_31, merchantName: null }),
      ],
      { aliasesByBill: aliases },
    );
    expect(matches).toEqual([
      expect.objectContaining({ billId: "nv-a", draftIds: ["big"] }),
      expect.objectContaining({ billId: "nv-b", draftIds: ["small"] }),
    ]);
  });

  it("the bill's match-alias column matches wording unrelated to the name", () => {
    // Bill "Rent" paid as "ACME PROPERTY MGMT" — no containment either way.
    // The user types the alias on the bill form; projection-server feeds it
    // through billAliasList into aliasesByBill.
    const rent = { id: "rent", name: "Rent", amountCents: 1450_00, intervalMonths: 1, anchorDate: "2026-07-01" };
    const drafts = [
      draft({ id: "ach", date: "2026-07-01", amountCents: 1450_00, description: "ACME PROPERTY MGMT LLC", merchantName: null }),
    ];
    expect(matchPaidBillOccurrences([rent], drafts)).toEqual([]);
    const matches = matchPaidBillOccurrences([rent], drafts, {
      aliasesByBill: new Map([["rent", billAliasList("ACME PROPERTY MGMT")]]),
    });
    expect(matches).toEqual([
      expect.objectContaining({ billId: "rent", occurrenceDate: "2026-07-01", draftIds: ["ach"] }),
    ]);
  });

  it("an excluded draft never matches heuristically, by name or alias", () => {
    const matches = matchPaidBillOccurrences(
      [nvEnergy],
      [draft({ billMatchExcluded: true })],
      { aliasesByBill: new Map([["bill-nv", ["NVENERGY PAYMENTS C/S"]]]) },
    );
    expect(matches).toEqual([]);
  });

  it("a manual link on an excluded draft still wins (exclusion only silences the heuristic)", () => {
    const matches = matchPaidBillOccurrences(
      [nvEnergy],
      [draft({ billMatchExcluded: true, linkedBillId: "bill-nv" })],
    );
    expect(matches).toEqual([
      expect.objectContaining({ billId: "bill-nv", draftIds: ["txn-1"] }),
    ]);
  });

  it("uses the per-occurrence override amount for the settle threshold", () => {
    const withOverride = {
      ...nvEnergy,
      amountCents: 300_00,
      overridesByDate: new Map([["2026-07-15", 130_00]]),
    };
    // $118.37 ≥ 35% of the $130 override → settles; vs the base $300 plan
    // (threshold $105) it would settle too, but vs a $400 override it must not.
    expect(matchPaidBillOccurrences([withOverride], [draft()])).toHaveLength(1);
    const highOverride = {
      ...nvEnergy,
      amountCents: 300_00,
      overridesByDate: new Map([["2026-07-15", 400_00]]),
    };
    expect(matchPaidBillOccurrences([highOverride], [draft({ amountCents: 30_00 })])).toEqual([]);
  });
});

describe("findUnpaidRecentOccurrences", () => {
  const bill = { id: "b1", name: "Rent", amountCents: 1450_00, intervalMonths: 1, anchorDate: "2026-07-01" };

  it("flags a recently-due occurrence with no matched payment", () => {
    expect(findUnpaidRecentOccurrences([bill], new Map(), { today: "2026-07-09" })).toEqual([
      { billId: "b1", billName: "Rent", dueDate: "2026-07-01", expectedCents: 1450_00 },
    ]);
  });

  it("stays quiet when the occurrence was matched to a payment", () => {
    const paid = new Map([["b1", [{ date: "2026-07-01" }]]]);
    expect(findUnpaidRecentOccurrences([bill], paid, { today: "2026-07-09" })).toEqual([]);
  });

  it("gives ACH posting lag before flagging (grace days)", () => {
    // Due yesterday — inside the 2-day posting grace, so not flagged yet.
    expect(findUnpaidRecentOccurrences([bill], new Map(), { today: "2026-07-02" })).toEqual([]);
    // Two days later the grace has passed.
    expect(findUnpaidRecentOccurrences([bill], new Map(), { today: "2026-07-03" })).toHaveLength(1);
  });

  it("goes quiet past the lookback window instead of nagging forever", () => {
    // Jul 1 occurrence, 14 days later (> 12-day lookback) — silent.
    expect(findUnpaidRecentOccurrences([bill], new Map(), { today: "2026-07-15" })).toEqual([]);
  });

  it("skips occurrences whose override plans zero cash", () => {
    const withZero = { ...bill, overridesByDate: new Map([["2026-07-01", 0]]) };
    expect(findUnpaidRecentOccurrences([withZero], new Map(), { today: "2026-07-09" })).toEqual([]);
  });

  it("stops asking once the user has answered", () => {
    const answeredKeys = new Set([occurrenceKey("b1", "2026-07-01")]);
    expect(
      findUnpaidRecentOccurrences([bill], new Map(), { today: "2026-07-09", answeredKeys }),
    ).toEqual([]);
  });
});

describe("matchAllocatedObligations", () => {
  // The case this exists for: a single $4,000 transfer covering a $2,000
  // recurring bill plus a $2,000 one-off. No heuristic can recover that split —
  // only the person who sent the money knows how it divides.
  const wife = {
    id: "bill-wife",
    name: "Wife",
    amountCents: 2000_00,
    intervalMonths: 1,
    anchorDate: "2026-07-01",
  };
  const oneOff = {
    id: "extra-1",
    description: "Extra to wife",
    date: "2026-07-01",
    amountCents: 2000_00,
  };
  const split = {
    id: "txn-4000",
    date: "2026-06-27",
    description: "ACH ORIG DEBIT Lisette Izada",
    merchantName: null,
    amountCents: 4000_00,
    allocations: [
      {
        targetKind: "bill" as const,
        targetId: "bill-wife",
        targetDate: "2026-07-01",
        amountCents: 2000_00,
      },
      {
        targetKind: "extra" as const,
        targetId: "extra-1",
        targetDate: "2026-07-01",
        amountCents: 2000_00,
      },
    ],
  };

  it("settles both obligations from one transaction", () => {
    const out = matchAllocatedObligations([wife], [oneOff], [split]);
    expect(out.bills).toEqual([
      {
        billId: "bill-wife",
        occurrenceDate: "2026-07-01",
        draftIds: ["txn-4000"],
        paidDate: "2026-06-27",
        paidAmountCents: 2000_00,
      },
    ]);
    expect(out.extras).toEqual([
      {
        extraId: "extra-1",
        draftIds: ["txn-4000"],
        paidDate: "2026-06-27",
        paidAmountCents: 2000_00,
      },
    ]);
  });

  it("removes a split draft from heuristic matching entirely", () => {
    // Otherwise the same $4,000 could settle the bill twice: once by the
    // user's allocation, once by the name heuristic.
    const out = matchAllocatedObligations([wife], [oneOff], [split]);
    expect(out.allocatedDraftIds.has("txn-4000")).toBe(true);
    expect(out.allocatedOccurrenceKeys.has(occurrenceKey("bill-wife", "2026-07-01"))).toBe(true);

    const heuristic = matchPaidBillOccurrences([wife], [split], {
      aliasesByBill: new Map([["bill-wife", ["Lisette Izada"]]]),
      excludeDraftIds: out.allocatedDraftIds,
      excludeOccurrenceKeys: out.allocatedOccurrenceKeys,
    });
    expect(heuristic).toEqual([]);
  });

  it("leaves an unsplit draft to the heuristic", () => {
    const plain = { ...split, id: "txn-plain", allocations: undefined };
    const out = matchAllocatedObligations([wife], [oneOff], [plain]);
    expect(out.bills).toEqual([]);
    expect(out.allocatedDraftIds.size).toBe(0);
    expect(
      matchPaidBillOccurrences([wife], [plain], {
        aliasesByBill: new Map([["bill-wife", ["Lisette Izada"]]]),
        excludeDraftIds: out.allocatedDraftIds,
      }),
    ).toHaveLength(1);
  });

  it("honours the settle floor on an explicit portion", () => {
    // The user's word decides WHICH obligation the money went to, not whether
    // a token amount clears it — same rule as a manual bill link.
    const tiny = {
      ...split,
      allocations: [
        {
          targetKind: "bill" as const,
          targetId: "bill-wife",
          targetDate: "2026-07-01",
          amountCents: 50_00,
        },
      ],
    };
    const out = matchAllocatedObligations([wife], [oneOff], [tiny]);
    expect(out.bills).toEqual([]);
    // ...but the occurrence is still spoken for, so the heuristic stays out.
    expect(out.allocatedOccurrenceKeys.has(occurrenceKey("bill-wife", "2026-07-01"))).toBe(true);
  });

  it("sums two transactions allocated to the same obligation", () => {
    const half = (id: string, date: string) => ({
      id,
      date,
      description: "TRANSFER",
      merchantName: null,
      amountCents: 1000_00,
      allocations: [
        {
          targetKind: "bill" as const,
          targetId: "bill-wife",
          targetDate: "2026-07-01",
          amountCents: 1000_00,
        },
      ],
    });
    const out = matchAllocatedObligations(
      [wife],
      [],
      [half("txn-a", "2026-06-28"), half("txn-b", "2026-06-30")],
    );
    expect(out.bills[0]).toMatchObject({
      paidAmountCents: 2000_00,
      draftIds: ["txn-a", "txn-b"],
      paidDate: "2026-06-30", // latest contributing post
    });
  });

  it("ignores an allocation whose target no longer exists", () => {
    const orphan = {
      ...split,
      allocations: [
        {
          targetKind: "extra" as const,
          targetId: "deleted-extra",
          targetDate: "2026-07-01",
          amountCents: 2000_00,
        },
      ],
    };
    const out = matchAllocatedObligations([wife], [], [orphan]);
    expect(out.extras).toEqual([]);
  });
});

describe("findHeldOccurrences", () => {
  const bill = {
    id: "b1",
    name: "Rent",
    amountCents: 1450_00,
    intervalMonths: 1,
    anchorDate: "2026-07-01",
  };
  const noMarks: BillPaymentMark[] = [];

  it("holds a due occurrence nothing has confirmed as posted", () => {
    // The production case: due Jul 1, today Jul 3, nothing posted. The bank's
    // `current` balance still contains this money, so the projection must too.
    expect(findHeldOccurrences([bill], new Map(), noMarks, { today: "2026-07-03" })).toEqual([
      {
        billId: "b1",
        billName: "Rent",
        dueDate: "2026-07-01",
        amountCents: 1450_00,
        reason: "unconfirmed",
        holdDate: "2026-07-01",
      },
    ]);
  });

  it("holds from the due date with no grace period", () => {
    // The unpaid ALERT waits two days before nagging; a hold must not. The day
    // a bill comes due is the day its cash stops being spendable.
    expect(findHeldOccurrences([bill], new Map(), noMarks, { today: "2026-07-01" })).toHaveLength(1);
    // ...but not before it is due.
    expect(findHeldOccurrences([bill], new Map(), noMarks, { today: "2026-06-30" })).toEqual([]);
  });

  it("releases the hold once a posted transaction matches it", () => {
    const paid = new Map([["b1", [{ date: "2026-07-01" }]]]);
    expect(findHeldOccurrences([bill], paid, noMarks, { today: "2026-07-03" })).toEqual([]);
  });

  it("keeps holding a `sent` occurrence, on the date the money left", () => {
    const marks: BillPaymentMark[] = [
      {
        billId: "b1",
        dueDate: "2026-07-01",
        state: "sent",
        amountCents: null,
        markedDate: "2026-06-29",
      },
    ];
    expect(findHeldOccurrences([bill], new Map(), marks, { today: "2026-07-03" })).toEqual([
      {
        billId: "b1",
        billName: "Rent",
        dueDate: "2026-07-01",
        amountCents: 1450_00,
        reason: "sent",
        holdDate: "2026-06-29",
      },
    ]);
  });

  it("holds a `sent` occurrence paid ahead of its own due date", () => {
    // Paid Jul 20 for an Aug 1 bill: the money is gone now, so the hold rides
    // today even though the occurrence is still in the future.
    const marks: BillPaymentMark[] = [
      {
        billId: "b1",
        dueDate: "2026-08-01",
        state: "sent",
        amountCents: null,
        markedDate: "2026-07-20",
      },
    ];
    const held = findHeldOccurrences([bill], new Map(), marks, { today: "2026-07-20" });
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ dueDate: "2026-08-01", holdDate: "2026-07-20" });
  });

  it("uses the actual amount sent when it differs from the plan", () => {
    const marks: BillPaymentMark[] = [
      {
        billId: "b1",
        dueDate: "2026-07-01",
        state: "sent",
        amountCents: 1500_00,
        markedDate: "2026-07-01",
      },
    ];
    expect(
      findHeldOccurrences([bill], new Map(), marks, { today: "2026-07-03" })[0]?.amountCents,
    ).toBe(1500_00);
  });

  it("releases the cash for an occurrence paid outside the linked accounts", () => {
    const marks: BillPaymentMark[] = [
      {
        billId: "b1",
        dueDate: "2026-07-01",
        state: "paid_externally",
        amountCents: null,
        markedDate: "2026-07-01",
      },
    ];
    expect(findHeldOccurrences([bill], new Map(), marks, { today: "2026-07-03" })).toEqual([]);
    expect(findExternallyPaidOccurrences(marks)).toEqual([
      { billId: "b1", dueDate: "2026-07-01", amountCents: null },
    ]);
  });

  it("a matched payment beats a stale `sent` claim", () => {
    // Self-healing: the mark never has to be cleared. Once reality arrives it
    // simply stops mattering.
    const paid = new Map([["b1", [{ date: "2026-07-01" }]]]);
    const marks: BillPaymentMark[] = [
      {
        billId: "b1",
        dueDate: "2026-07-01",
        state: "sent",
        amountCents: null,
        markedDate: "2026-07-01",
      },
    ];
    expect(findHeldOccurrences([bill], paid, marks, { today: "2026-07-03" })).toEqual([]);
  });

  it("goes quiet past the lookback window instead of holding cash forever", () => {
    // Jul 1 occurrence, 14 days later (> 12-day lookback) — assumed paid
    // outside the linked accounts, cash released.
    const held = findHeldOccurrences([bill], new Map(), noMarks, { today: "2026-07-15" });
    expect(held.map((h) => h.dueDate)).toEqual([]);
  });

  it("keeps holding a `sent` occurrence past the lookback window", () => {
    // The window bounds GUESSES, not the user's own statement. If they said
    // the money is out, it stays out until something posts.
    const marks: BillPaymentMark[] = [
      {
        billId: "b1",
        dueDate: "2026-07-01",
        state: "sent",
        amountCents: null,
        markedDate: "2026-07-01",
      },
    ];
    expect(findHeldOccurrences([bill], new Map(), marks, { today: "2026-07-20" })).toHaveLength(1);
  });

  it("holds nothing for a zero-planned occurrence", () => {
    const withZero = { ...bill, overridesByDate: new Map([["2026-07-01", 0]]) };
    expect(findHeldOccurrences([withZero], new Map(), noMarks, { today: "2026-07-03" })).toEqual([]);
  });

  it("holds the overridden amount, not the base amount", () => {
    const withOverride = { ...bill, overridesByDate: new Map([["2026-07-01", 900_00]]) };
    expect(
      findHeldOccurrences([withOverride], new Map(), noMarks, { today: "2026-07-03" })[0]
        ?.amountCents,
    ).toBe(900_00);
  });
});
