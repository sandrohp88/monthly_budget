import { describe, expect, it } from "vitest";
import {
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
    { amountCents: 19999 },
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
