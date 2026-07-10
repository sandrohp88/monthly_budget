import { describe, expect, it } from "vitest";
import {
  draftMatchesPaycheckNote,
  matchPaycheckDeposits,
  PAYCHECK_MATCH_WINDOW_DAYS,
} from "./paycheck-reconciliation";

const paycheck = {
  id: "pay-1",
  payDate: "2026-07-10",
  amountCents: 2000_00,
  note: null,
};

function deposit(over: Partial<Parameters<typeof matchPaycheckDeposits>[1][number]> = {}) {
  return {
    id: "txn-1",
    date: "2026-07-10",
    description: "ACME CORP DIRECT DEP",
    merchantName: null,
    amountCents: -1950_00, // Plaid: negative = money in
    ...over,
  };
}

describe("matchPaycheckDeposits", () => {
  it("settles a paycheck from a deposit near the pay date", () => {
    expect(matchPaycheckDeposits([paycheck], [deposit()])).toEqual([
      {
        paycheckId: "pay-1",
        draftId: "txn-1",
        depositDate: "2026-07-10",
        depositAmountCents: 1950_00,
      },
    ]);
  });

  it("matches at the window edges and rejects one day beyond", () => {
    const early = deposit({ date: "2026-07-05" }); // -5 days
    const late = deposit({ date: "2026-07-15" }); // +5 days
    const tooEarly = deposit({ date: "2026-07-04" }); // -6 days
    const tooLate = deposit({ date: "2026-07-16" }); // +6 days
    expect(PAYCHECK_MATCH_WINDOW_DAYS).toBe(5);
    expect(matchPaycheckDeposits([paycheck], [early])).toHaveLength(1);
    expect(matchPaycheckDeposits([paycheck], [late])).toHaveLength(1);
    expect(matchPaycheckDeposits([paycheck], [tooEarly])).toEqual([]);
    expect(matchPaycheckDeposits([paycheck], [tooLate])).toEqual([]);
  });

  it("tolerates a light check down to 70% of planned, not below", () => {
    // Planned $2000 → floor $1400.
    expect(
      matchPaycheckDeposits([paycheck], [deposit({ amountCents: -1400_00 })]),
    ).toHaveLength(1);
    expect(
      matchPaycheckDeposits([paycheck], [deposit({ amountCents: -1399_99 })]),
    ).toEqual([]);
  });

  it("rejects a windfall deposit far above the planned amount", () => {
    // Planned $2000 → ceiling $4000. A $5000 tax refund is not a paycheck.
    expect(
      matchPaycheckDeposits([paycheck], [deposit({ amountCents: -4000_00 })]),
    ).toHaveLength(1);
    expect(
      matchPaycheckDeposits([paycheck], [deposit({ amountCents: -5000_00 })]),
    ).toEqual([]);
  });

  it("ignores debits — only money-in drafts can settle a paycheck", () => {
    expect(
      matchPaycheckDeposits([paycheck], [deposit({ amountCents: 1950_00 })]),
    ).toEqual([]);
  });

  it("ignores paychecks with a non-positive planned amount", () => {
    expect(
      matchPaycheckDeposits([{ ...paycheck, amountCents: 0 }], [deposit()]),
    ).toEqual([]);
  });

  it("splits two same-day paychecks (two earners) by best amount fit", () => {
    // Both paychecks land the same Friday; deposits are $2010 and $1180.
    // Each earner must take the deposit closest to their planned amount —
    // never both deposits lumped onto whoever sorts first.
    const mine = { id: "pay-a", payDate: "2026-07-10", amountCents: 2000_00, note: null };
    const spouse = { id: "pay-b", payDate: "2026-07-10", amountCents: 1200_00, note: null };
    const matches = matchPaycheckDeposits(
      [mine, spouse],
      [
        deposit({ id: "big", amountCents: -2010_00 }),
        deposit({ id: "small", amountCents: -1180_00 }),
      ],
    );
    expect(matches).toEqual([
      expect.objectContaining({ paycheckId: "pay-a", draftId: "big", depositAmountCents: 2010_00 }),
      expect.objectContaining({ paycheckId: "pay-b", draftId: "small", depositAmountCents: 1180_00 }),
    ]);
  });

  it("one deposit settles at most one paycheck", () => {
    const a = { id: "pay-a", payDate: "2026-07-10", amountCents: 2000_00, note: null };
    const b = { id: "pay-b", payDate: "2026-07-10", amountCents: 2000_00, note: null };
    const matches = matchPaycheckDeposits([a, b], [deposit()]);
    expect(matches).toHaveLength(1);
  });

  it("one paycheck takes at most one deposit — the closer amount wins", () => {
    const matches = matchPaycheckDeposits(
      [paycheck],
      [
        deposit({ id: "closer", amountCents: -1990_00 }),
        deposit({ id: "farther", amountCents: -1700_00 }),
      ],
    );
    expect(matches).toEqual([
      expect.objectContaining({ draftId: "closer", depositAmountCents: 1990_00 }),
    ]);
  });

  it("prefers a note-matched deposit over a slightly closer amount", () => {
    // Same-day near-tie: the employer hint on the note breaks it even though
    // the other deposit's amount fits marginally better. Containment is
    // whole-note (like the bill name gate), so the note is just the employer.
    const hinted = { id: "pay-a", payDate: "2026-07-10", amountCents: 2000_00, note: "ACME" };
    const matches = matchPaycheckDeposits(
      [hinted],
      [
        deposit({ id: "other", description: "ZORP LLC PAYROLL", amountCents: -2000_00 }),
        deposit({ id: "acme", description: "ACME CORP DIRECT DEP", amountCents: -1980_00 }),
      ],
    );
    expect(matches).toEqual([expect.objectContaining({ draftId: "acme" })]);
  });

  it("a note never gates eligibility — an unmatched note still settles by amount+date", () => {
    const hinted = { ...paycheck, note: "ACME payroll" };
    const matches = matchPaycheckDeposits(
      [hinted],
      [deposit({ description: "GENERIC BANK ACH CREDIT" })],
    );
    expect(matches).toHaveLength(1);
  });
});

describe("draftMatchesPaycheckNote", () => {
  it("matches through punctuation/case/concatenation", () => {
    expect(
      draftMatchesPaycheckNote("ACME payroll", {
        description: "ACMEPAYROLL DIR DEP",
        merchantName: null,
      }),
    ).toBe(true);
    expect(
      draftMatchesPaycheckNote("ACME payroll", {
        description: "ZORP LLC",
        merchantName: "Zorp",
      }),
    ).toBe(false);
  });

  it("refuses to match on very short notes", () => {
    expect(draftMatchesPaycheckNote("HR", { description: "HR BLOCK", merchantName: null })).toBe(false);
  });
});
