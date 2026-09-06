import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

vi.mock("server-only", () => ({}));

vi.mock("./auth", () => ({
  hashPassword: async (p: string) => `mock-hash-${p}`,
}));

vi.mock("./dates", async (importActual) => {
  const actual = await importActual<typeof import("./dates")>();
  return {
    ...actual,
    todayIso: () => "2026-05-04",
  };
});

import { __resetDbCacheForTests, getDb, runMigrations } from "./db/client";
import { settings, users } from "./db/schema";
import { newId } from "./ids";
import { buildProjection } from "./projection-server";
import {
  createBill,
  createCreditCard,
  createExtra,
  createPlaidItem,
  createPromo,
  createStatement,
  updateSettings,
  upsertBillPaymentState,
  upsertCreditCardPaymentOverride,
  upsertPlaidAccount,
  updatePlaidAccount,
  upsertPlaidDraft,
  replaceDraftAllocations,
  deleteCreditCardPaymentOverride,
} from "./repos";

let dbDir: string;

beforeEach(() => {
  __resetDbCacheForTests();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-projection-server-"));
  process.env.DATABASE_URL = `file:${path.join(dbDir, "test.db")}`;
  getDb();
  runMigrations();
});

afterEach(() => {
  __resetDbCacheForTests();
  try {
    fs.rmSync(dbDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

async function makeUser(): Promise<{ id: string }> {
  const db = getDb();
  const id = newId();
  await db
    .insert(users)
    .values({
      id,
      email: "projection@example.com",
      passwordHash: "x".repeat(64),
      displayName: "Projection Tester",
      role: "admin",
    })
    .run();
  await db
    .insert(settings)
    .values({
      id: newId(),
      userId: id,
      startingBalanceCents: 1_000_00,
      defaultPaycheckCents: 0,
      firstPaydayDate: "2026-05-08",
      payFrequencyDays: 14,
      projectionMonths: 2,
      currency: "USD",
      timezone: "America/Los_Angeles",
    })
    .run();
  return { id };
}

async function seedPromoProjection(statementBalanceCents: number | null) {
  const user = await makeUser();
  const card = await createCreditCard(user.id, {
    name: "PayPal",
    statementDay: 15,
    dueDay: 10,
    currentBalanceCents: 1_000_00,
    autoPay: false,
    isActive: true,
  });
  if (statementBalanceCents !== null) {
    await createStatement(card.id, {
      statementDate: "2026-05-15",
      dueDate: "2026-06-10",
      statementBalanceCents,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });
  }
  await createPromo(user.id, card.id, {
    description: "deferred-interest purchase",
    originalAmountCents: 1_000_00,
    remainingAmountCents: 1_000_00,
    startDate: "2026-05-01",
    endDate: "2026-12-31",
    monthlyPaymentCents: 125_00,
    notes: null,
    isActive: true,
  });

  const projection = await buildProjection(user.id);
  return projection?.rows.find((r) => r.date === "2026-06-10");
}

describe("buildProjection promo statement reconciliation", () => {
  it("does not project a promo payment when the statement due amount is zero", async () => {
    const row = await seedPromoProjection(0);
    expect(
      row?.events.some((event) => event.label === "PayPal promo (deferred-interest purchase)"),
    ).toBe(false);
  });

  it("does not double-count a promo payment when a positive statement already covers the cycle", async () => {
    const row = await seedPromoProjection(125_00);
    expect(
      row?.events.some((event) => event.label === "PayPal promo (deferred-interest purchase)"),
    ).toBe(false);
    // The statement is a zero-cash due marker (the app no longer force-pays it).
    expect(row?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "PayPal",
          amountCents: 0,
          dueMarker: true,
          paymentDueCents: 125_00,
        }),
      ]),
    );
  });

  it("marks the unpaid portion of a partially-paid statement as the due balance", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Partial Card",
      statementDay: 15,
      dueDay: 10,
      currentBalanceCents: 300_00,
      autoPay: false,
      isActive: true,
    });
    await createStatement(card.id, {
      statementDate: "2026-05-15",
      dueDate: "2026-06-10",
      statementBalanceCents: 200_00,
      paidAmountCents: 50_00,
      paidDate: "2026-06-01",
      notes: null,
    });

    const projection = await buildProjection(user.id);
    const event = projection?.rows
      .find((r) => r.date === "2026-06-10")
      ?.events.find((e) => e.label === "Partial Card" && e.dueMarker);

    expect(event).toMatchObject({
      amountCents: 0,
      dueMarker: true,
      estimated: false,
      paymentDueCents: 150_00,
    });
  });

  it("marks a Plaid minimum payment as the due balance when PayPal reports a zero statement balance", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "PayPal",
      statementDay: 15,
      dueDay: 10,
      currentBalanceCents: 900_00,
      autoPay: false,
      isActive: true,
    });
    await createStatement(card.id, {
      statementDate: "2026-05-15",
      dueDate: "2026-06-10",
      statementBalanceCents: 0,
      minimumPaymentCents: 35_00,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });

    const projection = await buildProjection(user.id);
    const event = projection?.rows
      .find((r) => r.date === "2026-06-10")
      ?.events.find((e) => e.label === "PayPal" && e.dueMarker);

    expect(event).toMatchObject({
      amountCents: 0,
      dueMarker: true,
      paymentDueCents: 35_00,
      paymentBalanceCents: 900_00,
    });
  });

  it("uses the full statement balance as the due when Plaid also returns a lower minimum payment", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Rewards Card",
      statementDay: 15,
      dueDay: 10,
      currentBalanceCents: 500_00,
      autoPay: false,
      isActive: true,
    });
    await createStatement(card.id, {
      statementDate: "2026-05-15",
      dueDate: "2026-06-10",
      statementBalanceCents: 200_00,
      minimumPaymentCents: 35_00,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });

    const projection = await buildProjection(user.id);
    const event = projection?.rows
      .find((r) => r.date === "2026-06-10")
      ?.events.find((e) => e.label === "Rewards Card" && e.dueMarker);

    expect(event).toMatchObject({
      amountCents: 0,
      dueMarker: true,
      paymentDueCents: 200_00,
    });
  });

  it("does not double-count a promo when paidAmountCents is zero on an unpaid statement", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "PayPal",
      statementDay: 15,
      dueDay: 10,
      currentBalanceCents: 1_000_00,
      autoPay: false,
      isActive: true,
    });
    await createStatement(card.id, {
      statementDate: "2026-05-15",
      dueDate: "2026-06-10",
      statementBalanceCents: 125_00,
      paidAmountCents: 0,
      paidDate: null,
      notes: null,
    });
    await createPromo(user.id, card.id, {
      description: "deferred-interest purchase",
      originalAmountCents: 1_000_00,
      remainingAmountCents: 1_000_00,
      startDate: "2026-05-01",
      endDate: "2026-12-31",
      monthlyPaymentCents: 125_00,
      notes: null,
      isActive: true,
    });

    const row = (await buildProjection(user.id))?.rows.find((r) => r.date === "2026-06-10");

    expect(
      row?.events.some((event) => event.label === "PayPal promo (deferred-interest purchase)"),
    ).toBe(false);
    // The statement due date shows as a zero-cash marker, not a forced payment.
    expect(row?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "PayPal",
          amountCents: 0,
          dueMarker: true,
          paymentDueCents: 125_00,
        }),
      ]),
    );
  });

  it("carries card balance and amount-due metadata on promo projection rows", async () => {
    const row = await seedPromoProjection(null);
    expect(row?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "PayPal promo (deferred-interest purchase)",
          amountCents: 125_00,
          originalAmountCents: 125_00,
          paymentDueCents: 125_00,
          paymentBalanceCents: 875_00,
        }),
      ]),
    );
  });

  it("allows a planned card payment above the statement due amount", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "PayPal",
      statementDay: 15,
      dueDay: 10,
      currentBalanceCents: 1_000_00,
      autoPay: false,
      isActive: true,
    });
    await createStatement(card.id, {
      statementDate: "2026-05-15",
      dueDate: "2026-06-10",
      statementBalanceCents: 125_00,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });
    await createPromo(user.id, card.id, {
      description: "deferred-interest purchase",
      originalAmountCents: 1_000_00,
      remainingAmountCents: 1_000_00,
      startDate: "2026-05-01",
      endDate: "2026-12-31",
      monthlyPaymentCents: 125_00,
      notes: null,
      isActive: true,
    });
    await upsertCreditCardPaymentOverride(user.id, card.id, {
      dueDate: "2026-06-10",
      amountCents: 300_00,
      notes: null,
    });

    const row = (await buildProjection(user.id))?.rows.find((r) => r.date === "2026-06-10");
    // The scheduled payment (300) is the cash out; the statement due (125) is a
    // covered marker. A payment above the due is allowed (covering pending spend).
    const paid = row?.events.find((e) => e.label === "PayPal planned payment");
    expect(paid).toMatchObject({ amountCents: 300_00 });
    const marker = row?.events.find((e) => e.label === "PayPal" && e.dueMarker);
    expect(marker).toMatchObject({
      amountCents: 0,
      paymentDueCents: 125_00,
      scheduledCoverCents: 125_00,
    });
  });

  it("deduplicates duplicate statement rows for the same card due date", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Shifted Statement Card",
      statementDay: 10,
      dueDay: 7,
      currentBalanceCents: 380_75,
      autoPay: false,
      isActive: true,
    });
    await createStatement(card.id, {
      statementDate: "2026-04-10",
      dueDate: "2026-05-07",
      statementBalanceCents: 653_13,
      paidAmountCents: 530_84,
      paidDate: "2026-04-20",
      notes: null,
    });
    await createStatement(card.id, {
      statementDate: "2026-04-19",
      dueDate: "2026-05-07",
      statementBalanceCents: 653_13,
      paidAmountCents: 530_84,
      paidDate: "2026-05-02",
      notes: null,
    });

    const row = (await buildProjection(user.id))?.rows.find((r) => r.date === "2026-05-07");
    const events = row?.events.filter(
      (event) => event.label === "Shifted Statement Card" && event.dueMarker,
    );

    expect(events).toHaveLength(1);
    expect(events?.[0]).toMatchObject({
      amountCents: 0,
      dueMarker: true,
      paymentDueCents: 122_29,
    });
  });
});

describe("buildProjection open-cycle estimate", () => {
  it("does not layer a live-balance estimate on a due date that already has a recorded statement", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Estimate Card",
      statementDay: 15,
      dueDay: 10,
      currentBalanceCents: 300_00,
      autoPay: false,
      isActive: true,
    });
    // Recorded statement due 2026-06-10 — the same date the open-cycle estimate
    // (next close 2026-05-15 → due 2026-06-10) would otherwise land on.
    await createStatement(card.id, {
      statementDate: "2026-05-15",
      dueDate: "2026-06-10",
      statementBalanceCents: 200_00,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });

    const row = (await buildProjection(user.id))?.rows.find((r) => r.date === "2026-06-10");
    // Statement is authoritative; the marker on that date is the recorded
    // statement (not estimated), and there's no separate estimate double-count.
    const markers = (row?.events ?? []).filter((e) => e.sourceId === card.id && e.dueMarker);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      amountCents: 0,
      estimated: false,
      paymentDueCents: 200_00,
    });
    // Zero cash leaves checking for a due marker.
    const cardCash = (row?.events ?? [])
      .filter((e) => e.sourceId === card.id)
      .reduce((sum, e) => sum + e.amountCents, 0);
    expect(cardCash).toBe(0);
  });

  it("still estimates the open cycle as a marker for a card with a balance but no recorded statement", async () => {
    const user = await makeUser();
    await createCreditCard(user.id, {
      name: "No Statement Card",
      statementDay: 15,
      dueDay: 10,
      currentBalanceCents: 300_00,
      autoPay: false,
      isActive: true,
    });

    const est = ((await buildProjection(user.id))?.rows ?? [])
      .flatMap((r) => r.events)
      .find((e) => e.label === "No Statement Card (est.)" && e.dueMarker);
    expect(est).toMatchObject({ amountCents: 0, estimated: true, paymentDueCents: 300_00 });
  });
});

describe("buildProjection linked starting balance", () => {
  async function seedLinkedStartingBalance(userId: string, balanceCents: number) {
    const item = await createPlaidItem(userId, {
      institutionId: "ins",
      institutionName: "Bank",
      accessTokenEnc: "00",
      accessTokenIv: "00",
      accessTokenTag: "00",
      cursor: null,
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: "checking",
      itemId: item.id,
      userId,
      name: "Checking",
      mask: "0001",
      type: "depository",
      subtype: "checking",
      balanceCents,
      updatedAt: Date.now(),
    });
    await updatePlaidAccount(userId, "checking", { useAsStartingBalance: true });
  }

  it("anchors on today and holds a past occurrence no transaction has confirmed", async () => {
    // The Plaid balance is `balances.current`, which excludes pending debits —
    // so a bill that came due yesterday and hasn't POSTED is still sitting
    // inside it. Releasing that cash because the date passed (the old
    // behavior) read the balance high by the whole bill. With no matching
    // draft the occurrence rides today as a live debit instead.
    const user = await makeUser();
    await seedLinkedStartingBalance(user.id, 5000_00);
    await createBill(user.id, {
      name: "Blue Falls",
      category: "Housing",
      amountCents: 4400_00,
      intervalMonths: 1,
      anchorDate: "2026-05-03", // yesterday relative to mocked today=2026-05-04
      autoPay: true,
      paidViaCardId: null,
      notes: null,
      isActive: true,
    });

    const projection = await buildProjection(user.id);

    expect(projection?.startDate).toBe("2026-05-04");
    expect(projection?.startingBalanceCents).toBe(5000_00);
    expect(projection?.rows[0]?.date).toBe("2026-05-04");
    // Yesterday's occurrence falls outside the rendered window, so it rides
    // the first visible day rather than vanishing — carrying its own due date.
    expect(projection?.rows[0]?.events).toContainEqual(
      expect.objectContaining({
        kind: "bill",
        label: "Blue Falls",
        amountCents: 4400_00,
        awaitingPost: true,
        heldSinceDate: "2026-05-03",
      }),
    );
    expect(projection?.rows[0]?.balanceCents).toBe(600_00);
    expect(projection?.pendingPosting.attributedCents).toBe(4400_00);

    // The next month's occurrence is still a normal, unheld cash debit.
    const nextMonth = projection?.rows.find((r) => r.date === "2026-06-03");
    expect(nextMonth?.expenseCents).toBe(4400_00);
    expect(nextMonth?.events.find((e) => e.label === "Blue Falls")?.awaitingPost).toBeUndefined();
  });

  it("reconstructs past balances from drafts when startingBalanceAsOf is rolled back", async () => {
    // User sets startingBalanceAsOf to 2026-05-01 (3 days before mocked today
    // 2026-05-04). Live linked balance is $500. Two posted drafts in window:
    //   2026-05-02: -$100 (expense)
    //   2026-05-03: +$30 (refund — negative amount = credit)
    // Reconstruction:
    //   end-of 2026-05-03 balance = $500
    //   end-of 2026-05-02 balance = $500 - (-$30) = $530   (refund hadn't landed)
    //   end-of 2026-05-01 balance = $530 - (-$100) = $630  (expense hadn't landed)
    // Forward walk lands at $500 on today.
    const user = await makeUser();
    await seedLinkedStartingBalance(user.id, 500_00);
    await updateSettings(user.id, { startingBalanceAsOf: "2026-05-01" });
    await upsertPlaidDraft({
      id: "txn-1",
      userId: user.id,
      accountId: "checking",
      date: "2026-05-02",
      description: "Coffee",
      originalDescription: null,
      amountCents: 100_00,
      plaidCategory: null,
      merchantName: "Cafe",
      pending: false,
      status: "approved",
      kind: "expense",
      linkedExpenseId: null,
      linkedPromoId: null,
    });
    await upsertPlaidDraft({
      id: "txn-2",
      userId: user.id,
      accountId: "checking",
      date: "2026-05-03",
      description: "Refund",
      originalDescription: null,
      amountCents: -30_00,
      plaidCategory: null,
      merchantName: "Store",
      pending: false,
      status: "approved",
      kind: "expense",
      linkedExpenseId: null,
      linkedPromoId: null,
    });

    const projection = await buildProjection(user.id);

    expect(projection?.startDate).toBe("2026-05-01");
    expect(projection?.startingBalanceCents).toBe(570_00); // 500 + (100 + -30)

    const may1 = projection?.rows.find((r) => r.date === "2026-05-01");
    expect(may1?.balanceCents).toBe(570_00);

    const may2 = projection?.rows.find((r) => r.date === "2026-05-02");
    expect(may2?.expenseCents).toBe(100_00);
    expect(may2?.balanceCents).toBe(470_00);

    const may3 = projection?.rows.find((r) => r.date === "2026-05-03");
    expect(may3?.incomeCents).toBe(30_00); // refund flows to income
    expect(may3?.balanceCents).toBe(500_00);

    const today = projection?.rows.find((r) => r.date === "2026-05-04");
    expect(today?.balanceCents).toBe(500_00);
  });

  it("renders past scheduled bills as paid markers once they age past the hold window", async () => {
    // A due date in the past is not evidence of payment, so a RECENT unmatched
    // occurrence keeps its cash (covered below). Past OVERDUE_LOOKBACK_DAYS,
    // though, the projection stops arguing: an occurrence that never matched
    // was almost certainly paid outside the linked accounts, and holding its
    // cash forever would be its own kind of wrong.
    const user = await makeUser();
    await seedLinkedStartingBalance(user.id, 500_00);
    await updateSettings(user.id, { startingBalanceAsOf: "2026-04-01" });
    await createBill(user.id, {
      name: "Blue Falls",
      category: "Housing",
      amountCents: 4400_00,
      intervalMonths: 1,
      anchorDate: "2026-04-03", // 31 days before today=2026-05-04
      autoPay: false,
      paidViaCardId: null,
      notes: null,
      isActive: true,
    });

    const projection = await buildProjection(user.id);
    const apr3 = projection?.rows.find((r) => r.date === "2026-04-03");
    const billEvent = apr3?.events.find((ev) => ev.label === "Blue Falls");

    expect(billEvent).toMatchObject({
      kind: "bill",
      amountCents: 0,
      originalAmountCents: 4400_00,
      isPaid: true,
    });
    // Aged-out occurrence is a marker only — no balance impact.
    expect(apr3?.expenseCents).toBe(0);
    // ...while THIS month's occurrence (2026-05-03, yesterday) is still inside
    // the window and keeps its cash. Same bill, two occurrences, two answers —
    // which is the point: age decides, not the bill.
    expect(projection?.pendingPosting.bills.map((b) => b.dueDate)).toEqual(["2026-05-03"]);
  });

  it("a planned card payment dated TODAY stays live in lookback mode (not phantom-settled)", async () => {
    // Real-world report (Costco ****8303): a payment the user scheduled for
    // today rendered as PAID/SETTLED although no transaction had posted, and
    // being "settled" it couldn't be rescheduled either. The lookback settle
    // pivot (tomorrow) assumed today's events were already inside the live
    // balance — true for posted reality, false for a user plan.
    const user = await makeUser();
    await seedLinkedStartingBalance(user.id, 500_00);
    await updateSettings(user.id, { startingBalanceAsOf: "2026-05-01" });
    const card = await createCreditCard(user.id, {
      name: "Costco",
      statementDay: 13,
      dueDay: 9,
      currentBalanceCents: 211_38,
      autoPay: false,
      isActive: true,
    });
    await upsertCreditCardPaymentOverride(user.id, card.id, {
      dueDate: "2026-05-04", // mocked today
      amountCents: 212_00,
      notes: null,
    });

    const today = (await buildProjection(user.id))?.rows.find((r) => r.date === "2026-05-04");
    const planned = today?.events.find((e) => e.label === "Costco planned payment");
    // Live cash debit: pending (not isPaid), full amount, moves the balance.
    expect(planned).toMatchObject({ amountCents: 212_00 });
    expect(planned?.isPaid).toBeFalsy();
    expect(today?.expenseCents).toBe(212_00);
  });

  it("a past planned card payment stays reserved until a checking debit posts", async () => {
    // Midnight is not evidence that checking posted the payment.
    const user = await makeUser();
    await seedLinkedStartingBalance(user.id, 500_00);
    await updateSettings(user.id, { startingBalanceAsOf: "2026-05-01" });
    const card = await createCreditCard(user.id, {
      name: "Costco",
      statementDay: 13,
      dueDay: 9,
      currentBalanceCents: 211_38,
      autoPay: false,
      isActive: true,
    });
    await upsertCreditCardPaymentOverride(user.id, card.id, {
      dueDate: "2026-05-02", // before mocked today
      amountCents: 212_00,
      notes: null,
    });

    const projection = await buildProjection(user.id);
    const may2 = projection?.rows.find((r) => r.date === "2026-05-02");
    expect(may2?.events.find((e) => e.label === "Costco planned payment")).toMatchObject({
      amountCents: 212_00,
      awaitingPost: true,
    });
    expect(projection?.pendingPosting.totalHeldCents).toBe(212_00);
    expect(projection?.rows.find((r) => r.date === "2026-05-04")).toMatchObject({
      balanceCents: 288_00,
      postedBalanceCents: 500_00,
    });
  });

  async function pendingCardFixture(date = "2026-05-02") {
    const user = await makeUser();
    await seedLinkedStartingBalance(user.id, 1000_00);
    const card = await createCreditCard(user.id, {
      name: "Test Visa",
      statementDay: 15,
      dueDay: 10,
      currentBalanceCents: 500_00,
      autoPay: false,
      isActive: true,
    });
    await upsertCreditCardPaymentOverride(user.id, card.id, {
      dueDate: date,
      amountCents: 200_00,
      notes: "pays-down:2026-05-10",
    });
    await createStatement(card.id, {
      statementDate: "2026-04-15", dueDate: "2026-05-10", statementBalanceCents: 500_00,
      paidAmountCents: null, paidDate: null, notes: null,
    });
    const post = async (id: string, pending: boolean, amountCents = 200_00) => {
      await upsertPlaidDraft({
        id,
        userId: user.id,
        accountId: "checking",
        date: "2026-05-04",
        description: "Test Visa Payment",
        merchantName: null,
        originalDescription: null,
        amountCents,
        pending,
        kind: "expense",
        status: "approved",
        plaidCategory: null,
        linkedExpenseId: null,
        linkedPromoId: null,
      });
    };
    return { user, card, post };
  }

  it("reserves past plans without lookback and includes them in today's posted/available pair", async () => {
    const { user } = await pendingCardFixture();
    const p = await buildProjection(user.id);
    expect(p?.rows[0]).toMatchObject({
      date: "2026-05-04",
      balanceCents: 800_00,
      postedBalanceCents: 1000_00,
    });
    expect(p?.rows[0]?.events.find((e) => e.awaitingPost)).toMatchObject({
      heldSinceDate: "2026-05-02",
      amountCents: 200_00,
    });
    expect(p?.pendingPosting.cardPayments).toHaveLength(1);
    expect(
      p?.rows.find((r) => r.date === "2026-05-10")?.events.find((e) => e.dueMarker)
        ?.scheduledCoverCents,
    ).toBe(200_00);
  });

  it("deducts a plan and the bank's pending view only once, then releases on posting", async () => {
    const { user, post } = await pendingCardFixture();
    await post("payment", true);
    const pending = await buildProjection(user.id);
    expect(pending?.pendingPosting.totalHeldCents).toBe(200_00);
    expect(pending?.pendingPosting.unattributedCents).toBe(0);
    expect(pending?.rows[0]?.balanceCents).toBe(800_00);
    await post("payment", false);
    // The same debit is now reflected in the bank's current balance.
    await getDb().run(`UPDATE plaid_accounts SET balance_cents = 80000 WHERE id = 'checking'`);
    const posted = await buildProjection(user.id);
    expect(posted?.pendingPosting.totalHeldCents).toBe(0);
    expect(posted?.rows[0]?.balanceCents).toBe(800_00);
    expect(posted?.rows[0]?.postedBalanceCents).toBe(800_00);
  });

  it("holds only the remainder after an explicit partial posting and clears when fully allocated", async () => {
    const { user, card, post } = await pendingCardFixture();
    await post("partial", false, 75_00);
    await replaceDraftAllocations(user.id, "partial", [
      {
        targetKind: "card_payment",
        targetId: card.id,
        targetDate: "2026-05-02",
        amountCents: 75_00,
      },
    ]);
    await getDb().run(`UPDATE plaid_accounts SET balance_cents = 92500 WHERE id = 'checking'`);
    const p = await buildProjection(user.id);
    expect(p?.pendingPosting.totalHeldCents).toBe(125_00);
    expect(p?.rows[0]?.balanceCents).toBe(800_00);
    await post("remainder", false, 125_00);
    await replaceDraftAllocations(user.id, "remainder", [
      {
        targetKind: "card_payment",
        targetId: card.id,
        targetDate: "2026-05-02",
        amountCents: 125_00,
      },
    ]);
    await getDb().run(`UPDATE plaid_accounts SET balance_cents = 80000 WHERE id = 'checking'`);
    expect((await buildProjection(user.id))?.pendingPosting.totalHeldCents).toBe(0);
  });

  it("projects future plans on their chosen date without reserving them today", async () => {
    const { user } = await pendingCardFixture("2026-05-06");
    const p = await buildProjection(user.id);
    expect(p?.pendingPosting.totalHeldCents).toBe(0);
    expect(p?.rows[0]?.balanceCents).toBe(1000_00);
    expect(p?.rows.find((r) => r.date === "2026-05-06")?.balanceCents).toBe(800_00);
  });

  it("stops debiting a future plan when its checking payment posts early", async () => {
    const { user, post } = await pendingCardFixture("2026-05-06");
    await post("early", false);
    await getDb().run(`UPDATE plaid_accounts SET balance_cents = 80000 WHERE id = 'checking'`);
    const p = await buildProjection(user.id);
    expect(p?.rows.find((r) => r.date === "2026-05-06")?.balanceCents).toBe(800_00);
    expect(
      p?.rows.find((r) => r.date === "2026-05-06")?.events.find((e) => e.isPaid)
        ?.originalAmountCents,
    ).toBe(200_00);
  });

  it("does not silently release an old unposted plan, and cancellation releases it", async () => {
    const { user, card } = await pendingCardFixture("2026-02-02");
    expect((await buildProjection(user.id))?.pendingPosting.totalHeldCents).toBe(200_00);
    await deleteCreditCardPaymentOverride(user.id, card.id, "2026-02-02");
    expect((await buildProjection(user.id))?.pendingPosting.totalHeldCents).toBe(0);
  });

  it("a one-time expense dated TODAY stays live in lookback mode (not phantom-settled)", async () => {
    // Same defect as the planned card payment above (PR #94), one row over:
    // a one-time expense is a user PLAN, so the live balance reflects it only
    // once it actually posts. Settling it at the lookback pivot (tomorrow)
    // turned a today-dated expense into a phantom "paid" marker that no
    // longer debited the projection and couldn't be edited or rescheduled.
    const user = await makeUser();
    await seedLinkedStartingBalance(user.id, 500_00);
    await updateSettings(user.id, { startingBalanceAsOf: "2026-05-01" });
    await createExtra(user.id, {
      date: "2026-05-04", // mocked today
      description: "Car registration",
      amountCents: 187_00,
      category: "Auto",
      paidViaCardId: null,
      notes: null,
      isActive: true,
    });

    const today = (await buildProjection(user.id))?.rows.find((r) => r.date === "2026-05-04");
    const expense = today?.events.find((e) => e.label === "Car registration");
    // Live cash debit: pending (not isPaid), full amount, moves the balance.
    expect(expense).toMatchObject({ amountCents: 187_00 });
    expect(expense?.isPaid).toBeFalsy();
    expect(today?.expenseCents).toBe(187_00);
  });

  it("a one-time expense dated in the PAST settles as a paid marker in lookback mode", async () => {
    // Once the date passes, reality (posted drafts inside the live balance)
    // carries the effect — the stale expense renders as a paid marker showing
    // the planned amount, and stops debiting the projection.
    const user = await makeUser();
    await seedLinkedStartingBalance(user.id, 500_00);
    await updateSettings(user.id, { startingBalanceAsOf: "2026-05-01" });
    await createExtra(user.id, {
      date: "2026-05-02", // before mocked today
      description: "Car registration",
      amountCents: 187_00,
      category: "Auto",
      paidViaCardId: null,
      notes: null,
      isActive: true,
    });

    const may2 = (await buildProjection(user.id))?.rows.find((r) => r.date === "2026-05-02");
    const expense = may2?.events.find((e) => e.label === "Car registration");
    expect(expense).toMatchObject({
      amountCents: 0,
      isPaid: true,
      originalAmountCents: 187_00, // the planned amount, for display
    });
    expect(may2?.expenseCents).toBe(0);
  });

  it("clamps lookback when startingBalanceAsOf is older than the cap (default 1970-01-01)", async () => {
    // Sanity check on the MAX_LOOKBACK_DAYS clamp: a user who never set the
    // field still gets the linked-no-lookback experience.
    const user = await makeUser();
    await seedLinkedStartingBalance(user.id, 500_00);
    // Default startingBalanceAsOf is 1970-01-01 from the schema.

    const projection = await buildProjection(user.id);
    expect(projection?.startDate).toBe("2026-05-04");
    expect(projection?.startingBalanceCents).toBe(500_00);
    expect(projection?.rows[0]?.date).toBe("2026-05-04");
  });
});

describe("scheduled paydown with a stale pays-down target (Prime Visa 9873, 2026-07-15)", () => {
  // Statement reconciliation / cycle edits can shift every projected due date
  // after a `pays-down:` note is written. The stored target then matches no
  // slot at all — and the directed cash used to cover NOTHING, so the due
  // marker four days after a $3,455 scheduled payment still warned about an
  // uncovered $832.26.
  it("covers the statement due marker and debits the running balance once", async () => {
    const user = await makeUser();
    const card = await createCreditCard(user.id, {
      name: "Prime Visa",
      statementDay: 10,
      dueDay: 7,
      gracePeriodDays: 25,
      currentBalanceCents: 832_26,
      autoPay: false,
      isActive: true,
    });
    await createStatement(card.id, {
      statementDate: "2026-05-10",
      dueDate: "2026-06-07",
      statementBalanceCents: 832_26,
      paidAmountCents: null,
      paidDate: null,
      notes: null,
    });
    // Scheduled 4 days before the due date, aimed at a slot that no longer
    // exists (nothing is projected on 2026-06-30 for this card).
    await upsertCreditCardPaymentOverride(user.id, card.id, {
      dueDate: "2026-06-03",
      amountCents: 3455_00,
      notes: "pays-down:2026-06-30",
    });

    const projection = await buildProjection(user.id);

    const payRow = projection?.rows.find((r) => r.date === "2026-06-03");
    const planned = payRow?.events.find((e) => e.label === "Prime Visa planned payment");
    expect(planned).toMatchObject({
      amountCents: 3455_00,
      paydownTargetDate: "2026-06-30",
    });
    expect(payRow?.expenseCents).toBe(3455_00);

    const dueRow = projection?.rows.find((r) => r.date === "2026-06-07");
    const marker = dueRow?.events.find((e) => e.label === "Prime Visa" && e.dueMarker);
    expect(marker).toMatchObject({
      amountCents: 0,
      paymentDueCents: 832_26,
      scheduledCoverCents: 832_26,
    });
    // The due marker never debits cash — only the scheduled payment moved money.
    expect(dueRow?.expenseCents).toBe(0);
  });
});

describe("buildProjection pending posting (money out, not yet posted)", () => {
  // The production report (Aug 1 bills, 2026-08-03): the ACH pull had left the
  // bank but hadn't posted. Plaid's live balance is `balances.current`, which
  // excludes pending debits, so the money was still inside it — while the
  // occurrence, being in the past, had stopped being projected. The balance
  // read high by the full amount of every bill in flight, and the "Unpaid"
  // alert had no action that could fix the number.

  async function seedLinked(
    userId: string,
    balanceCents: number,
    availableBalanceCents?: number | null,
  ) {
    const item = await createPlaidItem(userId, {
      institutionId: "ins",
      institutionName: "Bank",
      accessTokenEnc: "00",
      accessTokenIv: "00",
      accessTokenTag: "00",
      cursor: null,
      lastSyncedAt: null,
      isActive: true,
    });
    await upsertPlaidAccount({
      id: "checking",
      itemId: item.id,
      userId,
      name: "Checking",
      mask: "0001",
      type: "depository",
      subtype: "checking",
      balanceCents,
      availableBalanceCents: availableBalanceCents ?? null,
      updatedAt: Date.now(),
    });
    await updatePlaidAccount(userId, "checking", { useAsStartingBalance: true });
  }

  async function seedBill(userId: string) {
    return createBill(userId, {
      name: "Household Rent",
      category: "Housing",
      amountCents: 2000_00,
      intervalMonths: 1,
      anchorDate: "2026-05-01", // 3 days before mocked today=2026-05-04
      autoPay: true,
      paidViaCardId: null,
      notes: null,
      isActive: true,
    });
  }

  it("holds an unposted bill's cash instead of freeing it when the date passes", async () => {
    const user = await makeUser();
    await seedLinked(user.id, 10_000_00);
    await updateSettings(user.id, { startingBalanceAsOf: "2026-04-25" });
    await seedBill(user.id);

    const projection = await buildProjection(user.id);
    const may1 = projection?.rows.find((r) => r.date === "2026-05-01");

    // Before this change the occurrence rendered isPaid with amountCents 0.
    expect(may1?.events.find((e) => e.label === "Household Rent")).toMatchObject({
      kind: "bill",
      amountCents: 2000_00,
      awaitingPost: true,
    });
    expect(may1?.expenseCents).toBe(2000_00);
    expect(projection?.pendingPosting.attributedCents).toBe(2000_00);
    expect(projection?.pendingPosting.totalHeldCents).toBe(2000_00);
    // ...and the alert still asks about it, because nobody has answered yet.
    expect(projection?.unpaidRecentOccurrences.map((o) => o.dueDate)).toEqual(["2026-05-01"]);
  });

  it("surfaces the bank's own pending float when no bill explains it", async () => {
    // current $10,000 / available $9,250 — the bank says $750 is already gone.
    const user = await makeUser();
    await seedLinked(user.id, 10_000_00, 9_250_00);

    const projection = await buildProjection(user.id);
    const today = projection?.rows.find((r) => r.date === "2026-05-04");

    expect(projection?.pendingPosting.bankPendingOutflowCents).toBe(750_00);
    expect(projection?.pendingPosting.unattributedCents).toBe(750_00);
    expect(today?.events).toContainEqual(
      expect.objectContaining({
        label: "Pending at bank",
        amountCents: 750_00,
        awaitingPost: true,
      }),
    );
    expect(today?.balanceCents).toBe(9_250_00);
  });

  it("lets a marked bill ATTRIBUTE the bank float instead of stacking on it", async () => {
    // The invariant: totalHeld = max(bankPendingOutflow, attributed). The bill
    // the user marked sent IS the money the bank is reporting as pending —
    // holding both would double-count a single $2,000 payment.
    const user = await makeUser();
    await seedLinked(user.id, 10_000_00, 8_000_00); // bank: $2,000 pending
    await updateSettings(user.id, { startingBalanceAsOf: "2026-04-25" });
    const bill = await seedBill(user.id);
    await upsertBillPaymentState(user.id, bill!.id, {
      dueDate: "2026-05-01",
      state: "sent",
      amountCents: null,
      markedDate: "2026-05-01",
      notes: null,
    });

    const projection = await buildProjection(user.id);

    expect(projection?.pendingPosting.bankPendingOutflowCents).toBe(2000_00);
    expect(projection?.pendingPosting.attributedCents).toBe(2000_00);
    expect(projection?.pendingPosting.unattributedCents).toBe(0);
    expect(projection?.pendingPosting.totalHeldCents).toBe(2000_00);
    // Held exactly once: $10,000 − $2,000, not − $4,000.
    const today = projection?.rows.find((r) => r.date === "2026-05-04");
    expect(today?.balanceCents).toBe(8_000_00);
    // And the alert stops asking — the user answered.
    expect(projection?.unpaidRecentOccurrences).toEqual([]);
  });

  it("drops a sent mark from the In flight band once the payment actually posts", async () => {
    // The bug (2026-08-30): six bills marked "sent, awaiting post" stayed in
    // the In flight band after their payments posted and were linked to the
    // bills by hand. The cash hold released correctly — findHeldOccurrences
    // skips a paid occurrence — but the ANSWERED list was built from the raw
    // marks with no such check, so the band kept reporting money outstanding
    // that the app had already watched land.
    const user = await makeUser();
    await seedLinked(user.id, 10_000_00);
    await updateSettings(user.id, { startingBalanceAsOf: "2026-04-25" });
    const bill = await seedBill(user.id);
    await upsertBillPaymentState(user.id, bill!.id, {
      dueDate: "2026-05-01",
      state: "sent",
      amountCents: null,
      markedDate: "2026-05-01",
      notes: null,
    });

    // Before the payment posts the mark is the only thing we know: it stays,
    // holding the cash and offering its Undo.
    const before = await buildProjection(user.id);
    expect(before?.pendingPosting.answered).toHaveLength(1);
    expect(before?.pendingPosting.attributedCents).toBe(2000_00);

    // Now the real debit posts and reconciles against the occurrence.
    await upsertPlaidDraft({
      id: "txn-rent",
      userId: user.id,
      accountId: "checking",
      date: "2026-05-02",
      description: "Household Rent",
      originalDescription: null,
      amountCents: 2000_00,
      plaidCategory: null,
      merchantName: null,
      pending: false,
      status: "approved",
      kind: "expense",
      linkedExpenseId: null,
      linkedPromoId: null,
    });

    const after = await buildProjection(user.id);
    expect(after?.paidOccurrencesByBill[bill!.id]).toEqual([
      { occurrenceDate: "2026-05-01", paidDate: "2026-05-02", paidAmountCents: 2000_00 },
    ]);
    // The promise was kept — the row has nothing left to say.
    expect(after?.pendingPosting.answered).toEqual([]);
    // And the money is no longer held twice over.
    expect(after?.pendingPosting.attributedCents).toBe(0);
  });

  it("holds the larger of the two when the bank sees more pending than bills explain", async () => {
    // $2,000 bill marked sent, but the bank shows $2,500 pending: the extra
    // $500 is some other unposted spend and still has to come out.
    const user = await makeUser();
    await seedLinked(user.id, 10_000_00, 7_500_00);
    await updateSettings(user.id, { startingBalanceAsOf: "2026-04-25" });
    const bill = await seedBill(user.id);
    await upsertBillPaymentState(user.id, bill!.id, {
      dueDate: "2026-05-01",
      state: "sent",
      amountCents: null,
      markedDate: "2026-05-01",
      notes: null,
    });

    const projection = await buildProjection(user.id);
    expect(projection?.pendingPosting.attributedCents).toBe(2000_00);
    expect(projection?.pendingPosting.unattributedCents).toBe(500_00);
    expect(projection?.pendingPosting.totalHeldCents).toBe(2500_00);
    expect(projection?.rows.find((r) => r.date === "2026-05-04")?.balanceCents).toBe(7_500_00);
  });

  /**
   * The blind spot this closes: Alliant and Navy Federal both report
   * `available == current` on checking, so `current − available` is $0 no
   * matter how much is actually in flight. Plaid's own pending transaction
   * rows are the second, independent measure.
   */
  async function seedPendingDraft(userId: string, id: string, amountCents: number, pending = true) {
    await upsertPlaidDraft({
      id,
      userId,
      accountId: "checking",
      date: "2026-05-03",
      description: "Pending card swipe",
      originalDescription: null,
      amountCents,
      plaidCategory: null,
      merchantName: null,
      pending,
      status: "approved",
      kind: "expense",
      linkedExpenseId: null,
      linkedPromoId: null,
    });
  }

  it("holds pending transactions when the bank reports no float at all", async () => {
    // available == current, exactly like Alliant and Navy Federal.
    const user = await makeUser();
    await seedLinked(user.id, 10_000_00, 10_000_00);
    await seedPendingDraft(user.id, "pend_1", 300_00);

    const projection = await buildProjection(user.id);

    expect(projection?.pendingPosting.bankPendingOutflowCents).toBe(300_00);
    expect(projection?.pendingPosting.totalHeldCents).toBe(300_00);
    expect(projection?.rows.find((r) => r.date === "2026-05-04")?.balanceCents).toBe(9_700_00);
  });

  it("takes the larger of the two float measures, never their sum", async () => {
    // The bank says $750 pending and Plaid lists a $300 pending row. Those are
    // two views of the same pending set — holding $1,050 would double-count.
    const user = await makeUser();
    await seedLinked(user.id, 10_000_00, 9_250_00);
    await seedPendingDraft(user.id, "pend_1", 300_00);

    const projection = await buildProjection(user.id);

    expect(projection?.pendingPosting.bankPendingOutflowCents).toBe(750_00);
    expect(projection?.rows.find((r) => r.date === "2026-05-04")?.balanceCents).toBe(9_250_00);
  });

  it("ignores pending deposits — inflows must never release cash", async () => {
    const user = await makeUser();
    await seedLinked(user.id, 10_000_00, 10_000_00);
    // Negative = credit in Plaid's sign convention.
    await seedPendingDraft(user.id, "pend_in", -500_00);

    const projection = await buildProjection(user.id);

    expect(projection?.pendingPosting.totalHeldCents).toBe(0);
    expect(projection?.rows.find((r) => r.date === "2026-05-04")?.balanceCents).toBe(10_000_00);
  });

  it("stops holding a pending row once it posts", async () => {
    const user = await makeUser();
    await seedLinked(user.id, 10_000_00, 10_000_00);
    await seedPendingDraft(user.id, "pend_1", 300_00, false);

    const projection = await buildProjection(user.id);

    expect(projection?.pendingPosting.totalHeldCents).toBe(0);
  });

  it("never lets a pending transaction settle a bill and release its cash", async () => {
    // The dangerous direction: if a pending row could match the rent
    // occurrence, it would free $2,000 of held cash on the strength of a
    // transaction that can still change amount or vanish outright.
    const user = await makeUser();
    await seedLinked(user.id, 10_000_00, 10_000_00);
    await updateSettings(user.id, { startingBalanceAsOf: "2026-04-25" });
    await seedBill(user.id);
    await upsertPlaidDraft({
      id: "pend_rent",
      userId: user.id,
      accountId: "checking",
      date: "2026-05-01",
      description: "Household Rent",
      originalDescription: null,
      amountCents: 2000_00,
      plaidCategory: null,
      merchantName: null,
      pending: true,
      status: "approved",
      kind: "expense",
      linkedExpenseId: null,
      linkedPromoId: null,
    });

    const projection = await buildProjection(user.id);

    // Still held as an unposted occurrence, NOT settled into a zero-cash marker.
    expect(projection?.pendingPosting.attributedCents).toBe(2000_00);
    expect(projection?.pendingPosting.totalHeldCents).toBe(2000_00);
    expect(projection?.rows.find((r) => r.date === "2026-05-04")?.balanceCents).toBe(8_000_00);
  });

  it("settles an occurrence paid outside the linked accounts and frees its cash", async () => {
    const user = await makeUser();
    await seedLinked(user.id, 10_000_00);
    await updateSettings(user.id, { startingBalanceAsOf: "2026-04-25" });
    const bill = await seedBill(user.id);
    await upsertBillPaymentState(user.id, bill!.id, {
      dueDate: "2026-05-01",
      state: "paid_externally",
      amountCents: null,
      markedDate: "2026-05-01",
      notes: null,
    });

    const projection = await buildProjection(user.id);
    const may1 = projection?.rows.find((r) => r.date === "2026-05-01");

    expect(may1?.events.find((e) => e.label === "Household Rent")).toMatchObject({
      amountCents: 0,
      isPaid: true,
      paidExternally: true,
    });
    expect(may1?.expenseCents).toBe(0);
    expect(projection?.pendingPosting.totalHeldCents).toBe(0);
    expect(projection?.unpaidRecentOccurrences).toEqual([]);
  });

  it("hands the hold back to reconciliation once the transaction posts", async () => {
    // The self-healing half: the `sent` mark is never cleared by anything, it
    // simply stops mattering. A matched draft outranks it, the occurrence
    // becomes a paid marker, and the cash is released because the live balance
    // has now really dropped.
    const user = await makeUser();
    await seedLinked(user.id, 8_000_00);
    await updateSettings(user.id, { startingBalanceAsOf: "2026-04-25" });
    const bill = await seedBill(user.id);
    await upsertBillPaymentState(user.id, bill!.id, {
      dueDate: "2026-05-01",
      state: "sent",
      amountCents: null,
      markedDate: "2026-05-01",
      notes: null,
    });
    await upsertPlaidDraft({
      id: "txn-household",
      userId: user.id,
      accountId: "checking",
      date: "2026-05-02",
      description: "HOUSEHOLD RENT ACH",
      originalDescription: null,
      amountCents: 2000_00,
      plaidCategory: null,
      merchantName: "Household Rent",
      pending: false,
      status: "approved",
      kind: "expense",
      linkedExpenseId: null,
      linkedPromoId: null,
    });

    const projection = await buildProjection(user.id);
    const may1 = projection?.rows.find((r) => r.date === "2026-05-01");

    expect(may1?.events.find((e) => e.label === "Household Rent")).toMatchObject({
      amountCents: 0,
      isPaid: true,
    });
    expect(projection?.pendingPosting.totalHeldCents).toBe(0);
    expect(projection?.rows.find((r) => r.date === "2026-05-04")?.balanceCents).toBe(8_000_00);
  });

  it("holds nothing in manual mode — there is no transaction feed to be behind", async () => {
    const user = await makeUser();
    await updateSettings(user.id, { startingBalanceAsOf: "2026-05-04" });
    await seedBill(user.id);

    const projection = await buildProjection(user.id);
    expect(projection?.pendingPosting.totalHeldCents).toBe(0);
    expect(projection?.pendingPosting.bills).toEqual([]);
  });
});
