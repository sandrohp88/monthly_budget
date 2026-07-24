import { describe, expect, it } from "vitest";
import { buildCardForecast } from "./card-forecast";
import type { ProjectionEvent, ProjectionRow } from "./projection";

const CARD_NAMES = new Map([
  ["c1", "Prime Visa"],
  ["c2", "PayPal Credit"],
]);

function row(date: string, events: ProjectionEvent[]): ProjectionRow {
  return { date, incomeCents: 0, expenseCents: 0, balanceCents: 0, events };
}

function marker(
  cardId: string,
  dueCents: number,
  over: Partial<ProjectionEvent> = {},
): ProjectionEvent {
  return {
    kind: "extra",
    label: "Card",
    amountCents: 0,
    sourceId: cardId,
    sourceType: "creditCardPayment",
    paymentDueCents: dueCents,
    dueMarker: true,
    ...over,
  };
}

function cash(cardId: string, amountCents: number, dueCents: number): ProjectionEvent {
  return {
    kind: "extra",
    label: "Card promo",
    amountCents,
    sourceId: cardId,
    sourceType: "creditCardPayment",
    paymentDueCents: dueCents,
  };
}

describe("buildCardForecast", () => {
  it("buckets card obligations by month and splits statement / estimate / promo", () => {
    const rows = [
      row("2026-07-28", [marker("c1", 400_00)]),
      row("2026-08-28", [marker("c1", 250_00, { estimated: true }), cash("c1", 100_00, 100_00)]),
    ];

    const forecast = buildCardForecast({
      rows,
      today: "2026-07-24",
      cardNames: CARD_NAMES,
      months: 2,
    });

    expect(forecast.months.map((m) => m.month)).toEqual(["2026-07", "2026-08"]);
    expect(forecast.months[0]).toMatchObject({
      statementDueCents: 400_00,
      estimatedDueCents: 0,
      promoDueCents: 0,
      dueCents: 400_00,
      cashOutCents: 0,
    });
    expect(forecast.months[1]).toMatchObject({
      statementDueCents: 0,
      estimatedDueCents: 250_00,
      promoDueCents: 100_00,
      dueCents: 350_00,
      cashOutCents: 100_00,
    });
    expect(forecast.total.dueCents).toBe(750_00);
  });

  it("ignores non-card events and anything before today", () => {
    const rows = [
      row("2026-07-01", [marker("c1", 999_00)]),
      row("2026-07-28", [
        { kind: "bill", label: "Rent", amountCents: 1_500_00 },
        marker("c1", 400_00),
      ]),
    ];

    const forecast = buildCardForecast({
      rows,
      today: "2026-07-24",
      cardNames: CARD_NAMES,
      months: 1,
    });

    expect(forecast.total.dueCents).toBe(400_00);
  });

  it("drops rows past the requested month window", () => {
    const rows = [row("2026-07-28", [marker("c1", 100_00)]), row("2026-09-05", [marker("c1", 700_00)])];

    const forecast = buildCardForecast({
      rows,
      today: "2026-07-24",
      cardNames: CARD_NAMES,
      months: 2,
    });

    expect(forecast.throughMonth).toBe("2026-08");
    expect(forecast.total.dueCents).toBe(100_00);
  });

  it("counts scheduled coverage on markers and caps it at the amount owed", () => {
    const rows = [
      row("2026-07-28", [marker("c1", 400_00, { scheduledCoverCents: 150_00 })]),
      row("2026-08-28", [marker("c1", 200_00, { scheduledCoverCents: 900_00 })]),
    ];

    const forecast = buildCardForecast({
      rows,
      today: "2026-07-24",
      cardNames: CARD_NAMES,
      months: 2,
    });

    expect(forecast.months[0]!.coveredCents).toBe(150_00);
    // Over-coverage never exceeds what's owed, so "uncovered" can't go negative.
    expect(forecast.months[1]!.coveredCents).toBe(200_00);
    expect(forecast.total.coveredCents).toBe(350_00);
  });

  it("credits a merged promo+planned cash row's coverage only up to its own due", () => {
    // A planned payment merged onto a promo chunk's date: cash 600, promo due 100.
    // The planned 500 covers a marker elsewhere — counting it here too would
    // double-count coverage.
    const rows = [
      row("2026-07-28", [
        marker("c1", 500_00, { scheduledCoverCents: 500_00 }),
        cash("c1", 600_00, 100_00),
      ]),
    ];

    const forecast = buildCardForecast({
      rows,
      today: "2026-07-24",
      cardNames: CARD_NAMES,
      months: 1,
    });

    expect(forecast.total.dueCents).toBe(600_00);
    expect(forecast.total.coveredCents).toBe(600_00);
    expect(forecast.total.cashOutCents).toBe(600_00);
  });

  it("rolls up per card, biggest obligation first", () => {
    const rows = [
      row("2026-07-28", [marker("c1", 100_00), marker("c2", 900_00)]),
      row("2026-08-28", [marker("c1", 100_00)]),
    ];

    const forecast = buildCardForecast({
      rows,
      today: "2026-07-24",
      cardNames: CARD_NAMES,
      months: 2,
    });

    expect(forecast.cards.map((c) => [c.cardName, c.dueCents])).toEqual([
      ["PayPal Credit", 900_00],
      ["Prime Visa", 200_00],
    ]);
    expect(forecast.months[0]!.byCardId.c2).toMatchObject({ dueCents: 900_00 });
    expect(forecast.months[1]!.byCardId.c2).toBeUndefined();
  });

  it("emits empty buckets for months with no card activity", () => {
    const forecast = buildCardForecast({
      rows: [],
      today: "2026-11-15",
      cardNames: CARD_NAMES,
      months: 3,
    });

    expect(forecast.months.map((m) => m.month)).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(forecast.total.dueCents).toBe(0);
    expect(forecast.cards).toEqual([]);
  });
});
