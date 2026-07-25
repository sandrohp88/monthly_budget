import { describe, expect, it } from "vitest";
import {
  buildCardSpending,
  formatCategoryLabel,
  utilizationBand,
  type CardSpendingInput,
} from "./card-spending";
import type { CardTransaction } from "./repos";

function txn(over: Partial<CardTransaction> = {}): CardTransaction {
  return {
    id: "t1",
    accountId: "a1",
    date: "2026-07-20",
    description: "Store",
    merchantName: null,
    plaidCategory: null,
    amountCents: 50_00,
    ...over,
  };
}

function card(over: Partial<CardSpendingInput> = {}): CardSpendingInput {
  return {
    cardId: "c1",
    cardName: "Prime Visa",
    accountId: "a1",
    balanceCents: 200_00,
    creditLimitCents: 1_000_00,
    window: { start: "2026-07-10", end: "2026-08-09" },
    ...over,
  };
}

describe("utilizationBand", () => {
  it("bands on the 30 / 70 / 90 thresholds", () => {
    expect(utilizationBand(0)).toBe("low");
    expect(utilizationBand(0.299)).toBe("low");
    expect(utilizationBand(0.3)).toBe("moderate");
    expect(utilizationBand(0.7)).toBe("high");
    expect(utilizationBand(0.9)).toBe("maxed");
    expect(utilizationBand(1.4)).toBe("maxed");
  });
});

describe("formatCategoryLabel", () => {
  it("renders Plaid's SCREAMING_SNAKE categories as prose", () => {
    expect(formatCategoryLabel("GENERAL_MERCHANDISE")).toBe("General merchandise");
    expect(formatCategoryLabel("FOOD_AND_DRINK")).toBe("Food and drink");
    expect(formatCategoryLabel("TRAVEL")).toBe("Travel");
  });

  it("leaves prose categories alone", () => {
    expect(formatCategoryLabel("Uncategorized")).toBe("Uncategorized");
    expect(formatCategoryLabel("Kids' stuff")).toBe("Kids' stuff");
  });
});

describe("buildCardSpending", () => {
  it("sums only charges inside the open cycle window", () => {
    const result = buildCardSpending({
      cards: [card()],
      transactions: [
        txn({ id: "before", date: "2026-07-09", amountCents: 999_00 }),
        txn({ id: "in1", date: "2026-07-10", amountCents: 40_00 }),
        txn({ id: "in2", date: "2026-07-20", amountCents: 60_00 }),
        txn({ id: "future", date: "2026-07-25", amountCents: 500_00 }),
      ],
      today: "2026-07-24",
    });

    const c = result.cards[0]!;
    expect(c.cycleSpendCents).toBe(100_00);
    expect(c.transactionCount).toBe(2);
    expect(result.totalCycleSpendCents).toBe(100_00);
  });

  it("excludes payments toward the card, including legacy misclassified rows", () => {
    // These rows are stored `kind = 'expense'` (synced before migration 0015,
    // or while the account was unlinked) so the repo query lets them through.
    // Counting them would net the cycle out — or make it negative.
    const result = buildCardSpending({
      cards: [card()],
      transactions: [
        txn({ id: "buy", date: "2026-07-15", plaidCategory: "GENERAL_MERCHANDISE", amountCents: 80_00 }),
        txn({
          id: "pay1",
          date: "2026-07-16",
          plaidCategory: "LOAN_PAYMENTS",
          description: "ONLINE PAYMENT, THANK YOU",
          amountCents: -650_00,
        }),
        txn({
          id: "pay2",
          date: "2026-07-17",
          plaidCategory: "LOAN_DISBURSEMENTS",
          description: "Payment Thank You - Web",
          amountCents: -128_87,
        }),
      ],
      today: "2026-07-24",
    });

    const c = result.cards[0]!;
    expect(c.cycleSpendCents).toBe(80_00);
    expect(c.transactionCount).toBe(1);
  });

  it("keeps statement credits and rewards redemptions as real reductions", () => {
    // Unlike a payment, a statement credit or points redemption genuinely
    // lowers what the next statement will ask for.
    const result = buildCardSpending({
      cards: [card()],
      transactions: [
        txn({ id: "buy", date: "2026-07-15", plaidCategory: "GENERAL_MERCHANDISE", amountCents: 100_00 }),
        txn({
          id: "credit",
          date: "2026-07-16",
          plaidCategory: "INCOME",
          description: "CASH REWARDS STATEMENT CREDIT",
          amountCents: -17_72,
        }),
        txn({
          id: "points",
          date: "2026-07-17",
          plaidCategory: "OTHER",
          description: "Thankyou Points Redeemed TY OR298283572",
          amountCents: -31_39,
        }),
      ],
      today: "2026-07-24",
    });

    expect(result.cards[0]!.cycleSpendCents).toBe(100_00 - 17_72 - 31_39);
    expect(result.cards[0]!.transactionCount).toBe(3);
  });

  it("nets refunds out of cycle spend", () => {
    const result = buildCardSpending({
      cards: [card()],
      transactions: [
        txn({ id: "buy", date: "2026-07-15", amountCents: 120_00 }),
        txn({ id: "refund", date: "2026-07-18", amountCents: -20_00 }),
      ],
      today: "2026-07-24",
    });

    expect(result.cards[0]!.cycleSpendCents).toBe(100_00);
  });

  it("ignores transactions from other cards' accounts", () => {
    const result = buildCardSpending({
      cards: [card(), card({ cardId: "c2", cardName: "Other", accountId: "a2", balanceCents: 0 })],
      transactions: [
        txn({ id: "mine", accountId: "a1", date: "2026-07-15", amountCents: 70_00 }),
        txn({ id: "theirs", accountId: "a2", date: "2026-07-15", amountCents: 30_00 }),
      ],
      today: "2026-07-24",
    });

    const byId = new Map(result.cards.map((c) => [c.cardId, c]));
    expect(byId.get("c1")!.cycleSpendCents).toBe(70_00);
    expect(byId.get("c2")!.cycleSpendCents).toBe(30_00);
  });

  it("computes utilization, headroom, and band from balance vs limit", () => {
    const result = buildCardSpending({
      cards: [card({ balanceCents: 750_00, creditLimitCents: 1_000_00 })],
      transactions: [],
      today: "2026-07-24",
    });

    const c = result.cards[0]!;
    expect(c.utilization).toBeCloseTo(0.75);
    expect(c.headroomCents).toBe(250_00);
    expect(c.band).toBe("high");
    expect(result.crowded).toHaveLength(1);
  });

  it("reports an over-limit card above 100% rather than clamping", () => {
    const result = buildCardSpending({
      cards: [card({ balanceCents: 1_200_00, creditLimitCents: 1_000_00 })],
      transactions: [],
      today: "2026-07-24",
    });

    const c = result.cards[0]!;
    expect(c.utilization).toBeCloseTo(1.2);
    expect(c.headroomCents).toBe(-200_00);
    expect(c.band).toBe("maxed");
  });

  it("treats an unknown limit as unknown, not as 0%", () => {
    const result = buildCardSpending({
      cards: [card({ creditLimitCents: null })],
      transactions: [],
      today: "2026-07-24",
    });

    const c = result.cards[0]!;
    expect(c.utilization).toBeNull();
    expect(c.band).toBeNull();
    expect(c.headroomCents).toBeNull();
    expect(result.cardsWithoutLimit).toBe(1);
    expect(result.overallUtilization).toBeNull();
  });

  it("excludes unknown-limit cards from the overall ratio", () => {
    const result = buildCardSpending({
      cards: [
        card({ cardId: "known", balanceCents: 500_00, creditLimitCents: 1_000_00 }),
        card({ cardId: "unknown", accountId: "a2", balanceCents: 900_00, creditLimitCents: null }),
      ],
      transactions: [],
      today: "2026-07-24",
    });

    // 500 / 1000 — the unknown-limit card's 900 balance must not drag it down.
    expect(result.overallUtilization).toBeCloseTo(0.5);
    expect(result.totalLimitCents).toBe(1_000_00);
    expect(result.cardsWithoutLimit).toBe(1);
  });

  it("paces the cycle from elapsed days and never projects below actual spend", () => {
    // Cycle 2026-07-10..2026-08-09 (31 days); today is day 6 with $60 spent.
    const result = buildCardSpending({
      cards: [card()],
      transactions: [txn({ date: "2026-07-12", amountCents: 60_00 })],
      today: "2026-07-15",
    });

    const c = result.cards[0]!;
    expect(c.dailyPaceCents).toBe(10_00); // 6000c / 6 days
    expect(c.projectedCycleSpendCents).toBe(310_00); // 1000c * 31 days
    expect(c.daysToClose).toBe(25);
    expect(c.projectedCycleSpendCents).toBeGreaterThanOrEqual(c.cycleSpendCents);
  });

  it("sorts fullest first and parks unknown-limit cards at the back", () => {
    const result = buildCardSpending({
      cards: [
        card({ cardId: "low", balanceCents: 100_00, creditLimitCents: 1_000_00 }),
        card({ cardId: "none", accountId: "a3", creditLimitCents: null }),
        card({ cardId: "high", accountId: "a2", balanceCents: 800_00, creditLimitCents: 1_000_00 }),
      ],
      transactions: [],
      today: "2026-07-24",
    });

    expect(result.cards.map((c) => c.cardId)).toEqual(["high", "low", "none"]);
  });

  it("groups cycle spend by category, biggest first", () => {
    const result = buildCardSpending({
      cards: [card()],
      transactions: [
        txn({ id: "g1", date: "2026-07-15", plaidCategory: "Groceries", amountCents: 40_00 }),
        txn({ id: "g2", date: "2026-07-16", plaidCategory: "Groceries", amountCents: 35_00 }),
        txn({ id: "f1", date: "2026-07-17", plaidCategory: "Fuel", amountCents: 50_00 }),
        txn({ id: "u1", date: "2026-07-18", plaidCategory: null, amountCents: 10_00 }),
      ],
      today: "2026-07-24",
    });

    expect(result.cards[0]!.byCategory).toEqual([
      { category: "Groceries", amountCents: 75_00, count: 2 },
      { category: "Fuel", amountCents: 50_00, count: 1 },
      { category: "Uncategorized", amountCents: 10_00, count: 1 },
    ]);
  });

  it("gives a manual card with no linked account an empty cycle", () => {
    const result = buildCardSpending({
      cards: [card({ accountId: null })],
      transactions: [txn({ date: "2026-07-15", amountCents: 90_00 })],
      today: "2026-07-24",
    });

    const c = result.cards[0]!;
    expect(c.cycleSpendCents).toBe(0);
    expect(c.transactionCount).toBe(0);
    // Utilization still works — it comes from the balance, not transactions.
    expect(c.utilization).toBeCloseTo(0.2);
  });
});
