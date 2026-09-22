import { describe, expect, it } from "vitest";
import {
  cardPaymentKey,
  reconcilePlannedCardPayments,
  type PlannedCardPayment,
} from "./card-payment-reconciliation";
import type { ReconcilableDraft } from "./bill-reconciliation";

const plan: PlannedCardPayment = {
  cardId: "visa",
  cardName: "Test Visa ****1234",
  date: "2026-09-04",
  amountCents: 20000,
};
const draft: ReconcilableDraft = {
  id: "posted",
  date: "2026-09-08",
  description: "TEST VISA PAYMENT",
  merchantName: null,
  amountCents: 20000,
};

describe("reconcilePlannedCardPayments", () => {
  it("uses both posted legs to identify a card with a nickname", () => {
    const debit = { ...draft, description: "Withdrawal ACH Issuer" };
    const receipts = [{ cardId: plan.cardId, date: draft.date, amountCents: 20000 }];
    expect(reconcilePlannedCardPayments([plan], [], new Set(), receipts).size).toBe(0);
    expect(reconcilePlannedCardPayments([plan], [debit], new Set(), receipts).get("visa:2026-09-04")).toBe(20000);
    expect(reconcilePlannedCardPayments([plan], [debit], new Set(), [{ ...receipts[0]!, cardId: "different" }]).size).toBe(0);
  });
  it("matches exact posted debits naming the card, including after a holiday weekend", () => {
    expect(reconcilePlannedCardPayments([plan], [draft]).get("visa:2026-09-04")).toBe(20000);
  });
  it.each([
    { amountCents: -20000 },
    { amountCents: 19899 }, // $1.01 off: beyond NEAR_AMOUNT_CENTS
    { description: "Other Card Payment" },
    { description: "Test Visa purchase" },
    { date: "2026-08-01" },
    { linkedBillId: "bill" },
  ])("does not guess away cash for %j", (change) => {
    expect(reconcilePlannedCardPayments([plan], [{ ...draft, ...change }]).size).toBe(0);
  });
  it("does not reuse money assigned to a bill or another explicit allocation", () => {
    expect(reconcilePlannedCardPayments([plan], [draft], new Set([draft.id])).size).toBe(0);
    expect(
      reconcilePlannedCardPayments(
        [plan],
        [
          {
            ...draft,
            allocations: [
              { targetKind: "extra", targetId: "e", targetDate: plan.date, amountCents: 1 },
            ],
          },
        ],
      ).size,
    ).toBe(0);
  });
  it("leaves ambiguous same-amount payments and cards for manual linking", () => {
    expect(reconcilePlannedCardPayments([plan], [draft, { ...draft, id: "other" }]).size).toBe(0);
    expect(
      reconcilePlannedCardPayments([plan, { ...plan, cardId: "other-card" }], [draft]).size,
    ).toBe(0);
  });
  it("honors explicit partial allocations without adding a heuristic match on top", () => {
    const partial = {
      ...draft,
      id: "partial",
      amountCents: 5000,
      allocations: [
        {
          targetKind: "card_payment" as const,
          targetId: plan.cardId,
          targetDate: plan.date,
          amountCents: 5000,
        },
      ],
    };
    expect(reconcilePlannedCardPayments([plan], [partial, draft]).get("visa:2026-09-04")).toBe(
      5000,
    );
  });
});

// 2026-09-21, Lisette's account: five posted card payments went unmatched
// because checking descriptors name the ISSUER, not the card nickname.
describe("reconcilePlannedCardPayments: issuer names", () => {
  const plan = (cardId: string, cardName: string, amountCents: number, issuerName?: string) => ({
    cardId,
    cardName,
    issuerName: issuerName ?? null,
    date: "2026-09-05",
    amountCents,
  });
  const debit = (id: string, description: string, amountCents: number, date = "2026-09-08") => ({
    id,
    date,
    description,
    merchantName: null,
    amountCents,
  });
  const key = (cardId: string) => cardPaymentKey(cardId, "2026-09-05");

  it("matches the card's issuer with payment wording (Quicksilver <- Capital One)", () => {
    const posted = reconcilePlannedCardPayments(
      [plan("qs", "Quicksilver ****2729", 4819, "Capital One")],
      [debit("d", "Withdrawal Ach Capital One Type: Online Pmt Id: 9279744391", 4819)],
    );
    expect(posted.get(key("qs"))).toBe(4819);
  });

  it("matches the nickname without its short words (Discover it <- Discover Cap One)", () => {
    const posted = reconcilePlannedCardPayments(
      [plan("di", "Discover it ****4474", 2096, "Capital One")],
      [debit("d", "Withdrawal Ach Discover Cap One Type: Online Pmt Id: 9541719375", 2096)],
    );
    expect(posted.get(key("di"))).toBe(2096);
  });

  it("accepts transfer wording only together with the issuer (PayPal Credit <- Paypal Inst Xfer)", () => {
    const d = debit("d", "Withdrawal Ach Paypal Type: Inst Xfer Id: Paypalsi77", 100_000);
    expect(
      reconcilePlannedCardPayments([plan("pp", "PayPal Credit Card ****9288", 100_000, "PayPal")], [d]).get(key("pp")),
    ).toBe(100_000);
    // Same card, no known issuer: a transfer alone proves nothing.
    expect(
      reconcilePlannedCardPayments([plan("pp", "PayPal Credit Card ****9288", 100_000)], [d]).get(key("pp")),
    ).toBeUndefined();
  });

  it("strips generic words from the issuer (Sam's Club - Credit Card <- Samsclub ... Paymnt)", () => {
    const posted = reconcilePlannedCardPayments(
      [plan("sc", "Sam's Club® World Elite Mastercard® ****5885", 90_235, "Sam's Club - Credit Card")],
      [debit("d", "Withdrawal Ach Samsclub Mstrcrd Type: Syf Paymnt Id: 9069872103", 90_235)],
    );
    expect(posted.get(key("sc"))).toBe(90_235);
  });

  // 2026-09-21: Sam's posted $902.35 against a $903.00 plan and the plan sat
  // "awaiting post" (first unmatched, then 65 cents short after a manual link).
  it("settles a plan in full from a named payment within a dollar", () => {
    const posted = reconcilePlannedCardPayments(
      [plan("sc", "Sam's Club ****5885", 90_300, "Sam's Club - Credit Card")],
      [debit("d", "Withdrawal Ach Samsclub Mstrcrd Type: Syf Paymnt", 90_235)],
    );
    expect(posted.get(key("sc"))).toBe(90_300);
  });

  it("settles a plan in full from an explicit link within a dollar", () => {
    const posted = reconcilePlannedCardPayments(
      [plan("sc", "Sam's Club ****5885", 90_300)],
      [{
        ...debit("d", "Anything at all", 90_235),
        allocations: [{ targetKind: "card_payment", targetId: "sc", targetDate: "2026-09-05", amountCents: 90_235 }],
      }],
    );
    expect(posted.get(key("sc"))).toBe(90_300);
  });

  it("keeps a genuine partial payment partial", () => {
    const linked = reconcilePlannedCardPayments(
      [plan("sc", "Sam's Club ****5885", 90_300)],
      [{
        ...debit("d", "Anything at all", 50_000),
        allocations: [{ targetKind: "card_payment", targetId: "sc", targetDate: "2026-09-05", amountCents: 50_000 }],
      }],
    );
    expect(linked.get(key("sc"))).toBe(50_000);
    const auto = reconcilePlannedCardPayments(
      [plan("sc", "Sam's Club ****5885", 90_300, "Sam's Club - Credit Card")],
      [debit("d", "Withdrawal Ach Samsclub Mstrcrd Type: Syf Paymnt", 90_199)],
    );
    expect(auto.get(key("sc"))).toBeUndefined();
  });

  it("does not near-match through the receipt route, which pairs two bank amounts", () => {
    const posted = reconcilePlannedCardPayments(
      [plan("sc", "Nickname only", 90_300)],
      [debit("d", "Withdrawal ACH Issuer", 90_235)],
      new Set(),
      [{ cardId: "sc", date: "2026-09-08", amountCents: 90_235 }],
    );
    expect(posted.get(key("sc"))).toBeUndefined();
  });

  it("stays reserved when the issuer match is ambiguous", () => {
    const posted = reconcilePlannedCardPayments(
      [plan("qs", "Quicksilver", 5000, "Capital One"), plan("sv", "Savor", 5000, "Capital One")],
      [debit("d", "Withdrawal Ach Capital One Type: Online Pmt", 5000)],
    );
    expect(posted.get(key("qs"))).toBeUndefined();
    expect(posted.get(key("sv"))).toBeUndefined();
  });

  it("does not match an unrelated issuer", () => {
    const posted = reconcilePlannedCardPayments(
      [plan("qs", "Quicksilver", 5000, "Capital One")],
      [debit("d", "Withdrawal Ach Chase Credit Crd Type: Epay", 5000)],
    );
    expect(posted.get(key("qs"))).toBeUndefined();
  });
});
