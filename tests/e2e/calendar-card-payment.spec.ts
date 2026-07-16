import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("program the full statement payment from its calendar due event", async ({ page }) => {
  await ensureAuth(page);

  const today = new Date().toISOString().slice(0, 10);
  const statementDate = addDaysIso(today, -7);
  const dueDate = addDaysIso(today, 7);
  const plannedDate = addDaysIso(today, 6);

  const cardResponse = await page.request.post("/api/credit-cards", {
    data: {
      name: "Calendar Visa",
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

  await page.goto("/calendar");
  if (dueDate.slice(0, 7) !== today.slice(0, 7)) {
    await page.getByRole("button", { name: "Next month" }).click();
  }

  // Due markers are informational since PR #88 — the chip reads
  // "Card due · <name>" and its dialog action is "Schedule payment".
  await page.getByText("Card due · Calendar Visa").first().click();
  const dayDialog = page.getByRole("dialog");
  await expect(dayDialog.getByText(/card statement due/i)).toBeVisible();
  await expect(dayDialog.getByText(/\$500\.00/i).first()).toBeVisible();
  await dayDialog.getByRole("button", { name: /schedule payment/i }).click();

  // The plan dialog can stack on top of the still-open day dialog — scope by
  // its own content instead of role alone.
  const paymentDialog = page.getByRole("dialog").filter({ hasText: "Programmed payment date" });
  await expect(paymentDialog.getByText(/full statement to avoid interest/i)).toBeVisible();
  await paymentDialog.locator("#calendar-card-payment-date").fill(plannedDate);
  await paymentDialog.getByRole("button", { name: /pay amount due/i }).click();
  await paymentDialog.getByRole("button", { name: /save payment plan/i }).click();

  await expect(page.getByText(/card payment plan saved/i)).toBeVisible();
  await page.goto("/calendar");
  if (plannedDate.slice(0, 7) !== today.slice(0, 7)) {
    await page.getByRole("button", { name: "Next month" }).click();
  }
  await expect(page.getByText("Calendar Visa planned payment")).toBeVisible();
});
