import { describe, expect, it } from "vitest";
import {
  draftMatchesPaycheckNote,
  matchAllocatedIncome,
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

describe("matchPaycheckDeposits — the other earner's deposit", () => {
  // The real shape (2026-08-30): Lisette is paid $3,974 every 14 days and the
  // deposit posts a day early; her husband's $2,000 lands on the 1st. Her row
  // was already marked received by hand, so it left the unreconciled pool —
  // and her $3,974.43 deposit found only his $2,000 row within the window.
  const hers = { id: "hers", payDate: "2026-08-27", amountCents: 3974_00, note: null };
  const his = { id: "his", payDate: "2026-09-01", amountCents: 2000_00, note: "Husband" };
  const herDeposit = deposit({
    id: "igt-0827",
    date: "2026-08-27",
    description: "Deposit Ach Igt Type: Payroll",
    amountCents: -3974_43,
  });

  it("does not hand her deposit to his paycheck once her row is reconciled", () => {
    // Without the schedule reference this is the bug: his $2,000 row accepts
    // anything up to $4,000, so $3,974.43 sails under the ceiling.
    expect(matchPaycheckDeposits([his], [herDeposit])).toHaveLength(1);
    // With it, the deposit is recognized as plainly hers and left alone.
    expect(
      matchPaycheckDeposits([his], [herDeposit], { schedule: [hers, his] }),
    ).toEqual([]);
  });

  it("still settles her row when it is the one awaiting reconciliation", () => {
    expect(matchPaycheckDeposits([hers, his], [herDeposit], { schedule: [hers, his] })).toEqual([
      {
        paycheckId: "hers",
        draftId: "igt-0827",
        depositDate: "2026-08-27",
        depositAmountCents: 3974_43,
      },
    ]);
  });

  it("still settles his own deposit — the guard only rejects loose fits", () => {
    const hisDeposit = deposit({
      id: "p2p-0901",
      date: "2026-09-01",
      description: "Deposit Ach Sandro Herrera Type: P2p",
      amountCents: -2000_00,
    });
    expect(matchPaycheckDeposits([his], [hisDeposit], { schedule: [hers, his] })).toEqual([
      {
        paycheckId: "his",
        draftId: "p2p-0901",
        depositDate: "2026-09-01",
        depositAmountCents: 2000_00,
      },
    ]);
  });

  it("still tolerates a light check — a loose fit with no better claimant stands", () => {
    // $1,700 against his $2,000: loose, but nothing else in range is a
    // near-exact match for it, so the conservative band still applies.
    const light = deposit({ id: "light", date: "2026-09-01", amountCents: -1700_00 });
    expect(matchPaycheckDeposits([his], [light], { schedule: [hers, his] })).toHaveLength(1);
  });

  it("ignores a near-exact row that is nowhere near the deposit's date", () => {
    // Her NEXT cycle is out of the window, so it can't veto a match on his row.
    const far = { id: "hers-next", payDate: "2026-10-09", amountCents: 3974_00, note: null };
    const overtime = deposit({ id: "ot", date: "2026-09-01", amountCents: -3974_00 });
    expect(matchPaycheckDeposits([his], [overtime], { schedule: [far, his] })).toHaveLength(1);
  });

  it("defaults the schedule to the pool when the caller passes none", () => {
    expect(matchPaycheckDeposits([hers, his], [herDeposit])).toEqual([
      {
        paycheckId: "hers",
        draftId: "igt-0827",
        depositDate: "2026-08-27",
        depositAmountCents: 3974_43,
      },
    ]);
  });
});

describe("matchPaycheckDeposits — a note must not outrank a better amount", () => {
  // The label trap (2026-08-30). Her rows were labelled so the schedules card
  // would stop calling them "Main". The obvious label is her first name — but
  // her husband's P2P transfers name her as the RECIPIENT, so the label matched
  // HIS deposit's text. noteMatch outranks amount fit in the sort, so his
  // $4,000 transfer beat his own exactly-matching $4,000 row and landed on her
  // $3,974 paycheck: 1.99x is inside the amount band, so nothing else stopped it.
  const hisTransfer =
    "Deposit Ach Capital One Type: P2p Id: 9000000021 Co: Sandro Herrera Name: Lisette Izada Galiano";
  const hers = { id: "hers", payDate: "2026-07-31", amountCents: 3974_00, note: "Lisette" };
  const his = { id: "his", payDate: "2026-08-01", amountCents: 4000_00, note: "Husband" };
  const transfer = deposit({
    id: "p2p",
    date: "2026-07-28",
    description: hisTransfer,
    amountCents: -4000_00,
  });

  it("the label really does match his text — that part is not in doubt", () => {
    expect(draftMatchesPaycheckNote("Lisette", { description: hisTransfer, merchantName: null })).toBe(
      true,
    );
  });

  it("his deposit still lands on his row despite her label matching its text", () => {
    const m = matchPaycheckDeposits([hers, his], [transfer], { schedule: [hers, his] });
    expect(m).toEqual([expect.objectContaining({ paycheckId: "his", draftId: "p2p" })]);
  });

  it("and lands nowhere when his row is already reconciled, rather than on hers", () => {
    // His row is off the board, so only hers is assignable. $26 further from the
    // deposit than his was — leave it for the user instead of guessing.
    const m = matchPaycheckDeposits([hers], [transfer], { schedule: [hers, his] });
    expect(m).toEqual([]);
  });

  it("a note still decides between two paychecks that fit the amount equally", () => {
    // Same-day, same amount, two earners: here the note is the only signal, and
    // the guard stays out of the way because neither row fits better.
    const a = { id: "a", payDate: "2026-07-10", amountCents: 2000_00, note: "ACME" };
    const b = { id: "b", payDate: "2026-07-10", amountCents: 2000_00, note: "ZORP" };
    const d = deposit({ id: "acme", description: "ACME CORP DIRECT DEP", amountCents: -2000_00 });
    const m = matchPaycheckDeposits([a, b], [d], { schedule: [a, b] });
    expect(m).toEqual([expect.objectContaining({ paycheckId: "a" })]);
  });

  it("a deposit two days early still settles the expected paycheck", () => {
    // Payroll often posts before the scheduled payday. Two days is inside the
    // ±5 day window, so the expected paycheck is settled from that deposit.
    const early = deposit({ date: "2026-07-08" });
    expect(matchPaycheckDeposits([paycheck], [early])).toEqual([
      expect.objectContaining({
        paycheckId: "pay-1",
        draftId: "txn-1",
        depositDate: "2026-07-08",
        depositAmountCents: 1950_00,
      }),
    ]);
  });

  it("a cents-level difference is still a tie the note may break", () => {
    // $2.00 apart — inside PAYCHECK_BETTER_FIT_CENTS, so this stays the note's
    // call rather than being decided by small payroll drift.
    const a = { id: "a", payDate: "2026-07-10", amountCents: 2000_00, note: "ACME" };
    const b = { id: "b", payDate: "2026-07-10", amountCents: 1998_00, note: "ZORP" };
    const d = deposit({ id: "acme", description: "ACME CORP DIRECT DEP", amountCents: -1998_00 });
    const m = matchPaycheckDeposits([a, b], [d], { schedule: [a, b] });
    expect(m).toEqual([expect.objectContaining({ paycheckId: "a" })]);
  });
});

describe("matchPaycheckDeposits — one deposit covers a paycheck and a bonus", () => {
  // The paycheck and a one-time bonus were expected the same day and arrived
  // together, two days early, as a single deposit. A one-to-one assignment
  // keeps the worse-fitting income (here, the paycheck — the bonus is closer
  // and inside its own amount band) projected as still coming.
  const payDate = "2026-07-10";
  const paycheck = {
    id: "pay",
    payDate,
    amountCents: 1500_00,
    note: null,
    isOneTime: false,
  };
  const bonus = {
    id: "bonus",
    payDate,
    amountCents: 2000_00,
    note: "Q3 bonus",
    isOneTime: true,
  };
  const combined = deposit({
    id: "dep-combined",
    date: "2026-07-08", // two days early
    description: "ACME CORP DIRECT DEP",
    amountCents: -3500_00,
  });

  it("settles both incomes from the one early deposit, each with its own share", () => {
    const matches = matchPaycheckDeposits([paycheck, bonus], [combined], {
      schedule: [paycheck, bonus],
    });
    expect(matches).toEqual([
      {
        paycheckId: "bonus",
        draftId: "dep-combined",
        depositDate: "2026-07-08",
        depositAmountCents: 2000_00,
      },
      {
        paycheckId: "pay",
        draftId: "dep-combined",
        depositDate: "2026-07-08",
        depositAmountCents: 1500_00,
      },
    ]);
  });

  it("gives payroll variance to the paycheck and the planned amount to the bonus", () => {
    // $3,400 posted: $200 short of the $3,500 plan. The bonus is a known
    // figure; the paycheck absorbs the difference and still clears its band.
    const light = deposit({
      id: "dep-light",
      date: "2026-07-08",
      amountCents: -3400_00,
    });
    const matches = matchPaycheckDeposits([paycheck, bonus], [light], {
      schedule: [paycheck, bonus],
    });
    expect(matches).toEqual([
      expect.objectContaining({ paycheckId: "bonus", depositAmountCents: 2000_00 }),
      expect.objectContaining({ paycheckId: "pay", depositAmountCents: 1400_00 }),
    ]);
  });

  it("does not treat a normal paycheck deposit as also paying a nearby bonus", () => {
    const onlyPay = deposit({
      id: "dep-pay",
      date: "2026-07-08",
      amountCents: -1500_00,
    });
    expect(
      matchPaycheckDeposits([paycheck, bonus], [onlyPay], { schedule: [paycheck, bonus] }),
    ).toEqual([
      expect.objectContaining({
        paycheckId: "pay",
        draftId: "dep-pay",
        depositAmountCents: 1500_00,
      }),
    ]);
  });

  it("does not combine two scheduled paychecks — two earners still take one deposit each", () => {
    const hers = { id: "hers", payDate, amountCents: 2000_00, note: null, isOneTime: false };
    const his = { id: "his", payDate, amountCents: 1500_00, note: null, isOneTime: false };
    const matches = matchPaycheckDeposits(
      [hers, his],
      [deposit({ id: "both", date: "2026-07-08", amountCents: -3500_00 })],
      { schedule: [hers, his] },
    );
    expect(matches).toHaveLength(1);
  });

  it("leaves a deposit that is plainly the other earner's paycheck unmatched", () => {
    const hers = { id: "hers", payDate: "2026-07-10", amountCents: 3974_00, note: null };
    const his = { id: "his", payDate: "2026-07-10", amountCents: 2000_00, note: null };
    const hisBonus = {
      id: "his-bonus",
      payDate: "2026-07-10",
      amountCents: 1974_00,
      note: "Bonus",
      isOneTime: true,
    };
    const herDeposit = deposit({
      id: "hers-dep",
      date: "2026-07-08",
      amountCents: -3974_00,
    });
    // Her row is already reconciled, so only his paycheck and bonus are waiting.
    // $3,974 is her paycheck, not his $2,000 plus a $1,974 bonus.
    expect(
      matchPaycheckDeposits([his, hisBonus], [herDeposit], {
        schedule: [hers, his, hisBonus],
      }),
    ).toEqual([]);
  });

  it("combines a deposit too large for either income on its own", () => {
    // $6,500 is past the paycheck's $4,000 ceiling and the bonus's $6,000
    // ceiling, so a one-to-one pass finds nothing. The sum still explains it:
    // the bonus keeps $3,000 and the paycheck takes the $3,500 remainder.
    const bigPay = { ...paycheck, amountCents: 2000_00 };
    const bigBonus = { ...bonus, amountCents: 3000_00 };
    const big = deposit({ id: "dep-big", date: "2026-07-08", amountCents: -6500_00 });
    expect(matchPaycheckDeposits([bigPay, bigBonus], [big], { schedule: [bigPay, bigBonus] })).toEqual([
      expect.objectContaining({ paycheckId: "bonus", depositAmountCents: 3000_00 }),
      expect.objectContaining({ paycheckId: "pay", depositAmountCents: 3500_00 }),
    ]);
  });

  it("does not combine incomes outside the early/late window", () => {
    const tooEarly = deposit({ id: "far", date: "2026-07-04", amountCents: -3500_00 });
    expect(
      matchPaycheckDeposits([paycheck, bonus], [tooEarly], { schedule: [paycheck, bonus] }),
    ).toEqual([]);
  });
});

describe("matchAllocatedIncome", () => {
  const paycheck = {
    id: "pay",
    payDate: "2026-07-10",
    amountCents: 1500_00,
    note: null,
    isOneTime: false,
  };
  const bonus = {
    id: "bonus",
    payDate: "2026-07-10",
    amountCents: 2000_00,
    note: "Q3 bonus",
    isOneTime: true,
  };

  it("settles each income for the portion the user assigned", () => {
    const matches = matchAllocatedIncome([paycheck, bonus], [
      {
        ...deposit({ id: "dep", date: "2026-07-08", amountCents: -3500_00 }),
        allocations: [
          { targetKind: "paycheck", targetId: "pay", targetDate: "2026-07-10", amountCents: 1500_00 },
          { targetKind: "paycheck", targetId: "bonus", targetDate: "2026-07-10", amountCents: 2000_00 },
        ],
      },
    ]);
    expect(matches).toEqual([
      expect.objectContaining({ paycheckId: "bonus", depositAmountCents: 2000_00, depositDate: "2026-07-08" }),
      expect.objectContaining({ paycheckId: "pay", depositAmountCents: 1500_00 }),
    ]);
  });

  it("does not mark an income received from a token portion", () => {
    const matches = matchAllocatedIncome([paycheck, bonus], [
      {
        ...deposit({ id: "dep", date: "2026-07-08", amountCents: -3500_00 }),
        allocations: [
          { targetKind: "paycheck", targetId: "pay", targetDate: "2026-07-10", amountCents: 1_00 },
          { targetKind: "paycheck", targetId: "bonus", targetDate: "2026-07-10", amountCents: 2000_00 },
        ],
      },
    ]);
    expect(matches).toEqual([
      expect.objectContaining({ paycheckId: "bonus", depositAmountCents: 2000_00 }),
    ]);
  });
});
