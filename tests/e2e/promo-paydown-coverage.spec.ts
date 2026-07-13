import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("promo planner surfaces scheduled calendar paydowns that cover the balance", async ({
  page,
}) => {
  await ensureAuth(page);

  const today = new Date().toISOString().slice(0, 10);
  const dueDate = addDaysIso(today, 10);
  const payDate = addDaysIso(today, 3);

  const cardRes = await page.request.post("/api/credit-cards", {
    data: {
      name: "Coverage Card",
      statementDay: 15,
      statementCycleMode: "calendar_day",
      statementCycleIntervalDays: 31,
      dueDay: Number(dueDate.slice(8, 10)),
      currentBalanceCents: 200_00,
      autoPay: false,
    },
  });
  expect(cardRes.ok()).toBe(true);
  const { card } = (await cardRes.json()) as { card: { id: string } };

  // A $200 deferred-interest promo.
  const promoRes = await page.request.post(`/api/credit-cards/${card.id}/promos`, {
    data: {
      description: "Coverage Promo",
      originalAmountCents: 200_00,
      remainingAmountCents: 200_00,
      startDate: addDaysIso(today, -30),
      endDate: addDaysIso(today, 60),
    },
  });
  expect(promoRes.ok()).toBe(true);

  // A $250 calendar paydown — more than the whole promo balance.
  const paydownRes = await page.request.put(
    `/api/credit-cards/${card.id}/payment-overrides`,
    { data: { dueDate: payDate, amountCents: 250_00, notes: `pays-down:${dueDate}` } },
  );
  expect(paydownRes.ok()).toBe(true);

  await page.goto(`/credit-cards/${card.id}`);

  // The promo planner explains the promo balance is already covered.
  await expect(page.getByText(/scheduled on calendar/i)).toBeVisible();
  await expect(page.getByText(/\$250\.00/).first()).toBeVisible();
  await expect(page.getByText(/covers this card.s full promo balance/i)).toBeVisible();
});
