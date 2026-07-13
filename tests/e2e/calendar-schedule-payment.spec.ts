import { test, expect, type Page } from "@playwright/test";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function gotoCalendarMonthOf(page: Page, iso: string, today: string) {
  await page.goto("/calendar");
  if (iso.slice(0, 7) !== today.slice(0, 7)) {
    await page.getByRole("button", { name: "Next month" }).click();
  }
}

test("schedule a partial card paydown from a plain calendar day", async ({ page }) => {
  await ensureAuth(page);

  const today = new Date().toISOString().slice(0, 10);
  const statementDate = addDaysIso(today, -7);
  const dueDate = addDaysIso(today, 7);
  const paymentDate = addDaysIso(today, 2);
  const billAnchor = addDaysIso(today, 3);

  const cardResponse = await page.request.post("/api/credit-cards", {
    data: {
      name: "Paydown Visa",
      statementDay: Number(statementDate.slice(8, 10)),
      statementCycleMode: "calendar_day",
      statementCycleIntervalDays: 31,
      dueDay: Number(dueDate.slice(8, 10)),
      currentBalanceCents: 500_00,
      autoPay: false,
    },
  });
  expect(cardResponse.ok()).toBe(true);
  const { card } = (await cardResponse.json()) as { card: { id: string } };

  const statementResponse = await page.request.post(
    `/api/credit-cards/${card.id}/statements`,
    {
      data: {
        statementDate,
        dueDate,
        statementBalanceCents: 500_00,
      },
    },
  );
  expect(statementResponse.ok()).toBe(true);

  // A bill charged to the card — must appear as a zero-cash ON CARD marker.
  const billResponse = await page.request.post("/api/bills", {
    data: {
      name: "Streaming Sub",
      category: "Subscriptions",
      amountCents: 15_99,
      intervalMonths: 1,
      anchorDate: billAnchor,
      autoPay: false,
      paidViaCardId: card.id,
    },
  });
  expect(billResponse.ok()).toBe(true);

  // Schedule a $200 paydown from a day that has no card event of its own.
  await gotoCalendarMonthOf(page, paymentDate, today);
  await page.getByText(String(Number(paymentDate.slice(8, 10))), { exact: true }).click();
  const dayDialog = page.getByRole("dialog");
  await dayDialog.getByRole("button", { name: /plan card payment/i }).click();

  const scheduleDialog = page.getByRole("dialog");
  // Pick the card explicitly — other specs may have left cards in the DB and
  // the select defaults to the first one.
  await scheduleDialog.getByRole("combobox").click();
  await page.getByRole("option", { name: /paydown visa/i }).click();
  await expect(scheduleDialog.getByText(/next card payment/i)).toBeVisible();
  await expect(scheduleDialog.getByText(/\$500\.00/).first()).toBeVisible();
  await scheduleDialog.locator("#schedule-card-payment-amount").fill("200");
  await expect(scheduleDialog.getByText(/stays due on/i)).toBeVisible();
  await scheduleDialog.getByRole("button", { name: /schedule payment/i }).click();
  await expect(page.getByText(/card payment scheduled/i)).toBeVisible();

  // The paydown debits its own day…
  await gotoCalendarMonthOf(page, paymentDate, today);
  await expect(page.getByText("Paydown Visa planned payment")).toBeVisible();

  // …and the due date now carries only the remainder.
  await gotoCalendarMonthOf(page, dueDate, today);
  await page.getByText("Paydown Visa payment", { exact: false }).first().click();
  const dueDialog = page.getByRole("dialog");
  await expect(dueDialog.getByText(/\$300\.00/).first()).toBeVisible();
  await dueDialog.getByRole("button", { name: "CLOSE", exact: true }).click();

  // The scheduled paydown is editable AND deletable from its day detail.
  await gotoCalendarMonthOf(page, paymentDate, today);
  await page.getByText("Paydown Visa planned payment").click();
  const paydownDialog = page.getByRole("dialog");
  await expect(paydownDialog.getByText(/pays down the card payment due/i)).toBeVisible();
  await expect(paydownDialog.getByRole("button", { name: /edit plan/i })).toBeVisible();

  // One-click delete removes the scheduled payment.
  await paydownDialog.getByRole("button", { name: /delete scheduled payment/i }).click();
  await expect(page.getByText(/scheduled payment deleted/i)).toBeVisible();
  await gotoCalendarMonthOf(page, paymentDate, today);
  await expect(page.getByText("Paydown Visa planned payment")).toHaveCount(0);

  // The card-charged bill renders as an informational marker, not cash.
  await gotoCalendarMonthOf(page, billAnchor, today);
  await page.getByText("Streaming Sub").first().click();
  const billDialog = page.getByRole("dialog");
  await expect(billDialog.getByText(/charged to Paydown Visa/i)).toBeVisible();
});
