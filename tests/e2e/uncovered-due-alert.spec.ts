import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("dashboard warns when no planned payment covers a card due, clears once one does", async ({
  page,
}) => {
  await ensureAuth(page);

  const today = new Date().toISOString().slice(0, 10);
  // Due in 2 days: sorts ahead of any other spec's dues, so this card always
  // lands inside the alert's top-3 slice.
  const dueDate = addDaysIso(today, 2);
  const payDate = addDaysIso(today, 1);

  // Manual card with no live balance — the recorded statement below is the
  // only due marker this card produces.
  const cardRes = await page.request.post("/api/credit-cards", {
    data: {
      name: "Interest Alert Card",
      statementDay: 1,
      statementCycleMode: "calendar_day",
      statementCycleIntervalDays: 31,
      dueDay: 25,
      autoPay: false,
    },
  });
  expect(cardRes.ok()).toBe(true);
  const { card } = (await cardRes.json()) as { card: { id: string } };

  const statementRes = await page.request.post(`/api/credit-cards/${card.id}/statements`, {
    data: {
      statementDate: addDaysIso(today, -5),
      dueDate,
      statementBalanceCents: 321_00,
    },
  });
  expect(statementRes.ok()).toBe(true);

  // The alert's content element — anchored so ancestors (whose text starts
  // with nav/tile content) and the agenda strip (which also shows the due
  // marker) never match. Other specs' cards may appear in the alert too, so
  // every assertion is scoped to it rather than to the page.
  const interestAlert = page.locator("div").filter({ hasText: /^No planned payment covers/ });

  // No scheduled payment → the dashboard raises the interest alert.
  await page.goto("/");
  await expect(interestAlert).toHaveCount(1);
  await expect(interestAlert).toContainText("Interest Alert Card");
  await expect(interestAlert).toContainText("$321.00");
  await expect(interestAlert).toContainText("Schedule a payment");

  // Schedule a payment covering the full statement before its due date …
  const overrideRes = await page.request.put(`/api/credit-cards/${card.id}/payment-overrides`, {
    data: { dueDate: payDate, amountCents: 321_00 },
  });
  expect(overrideRes.ok()).toBe(true);

  // … and the card drops out of the alert (the alert itself may persist for
  // other cards; the agenda strip still shows the now-covered marker).
  await page.goto("/");
  await expect(interestAlert.filter({ hasText: "Interest Alert Card" })).toHaveCount(0);
});
