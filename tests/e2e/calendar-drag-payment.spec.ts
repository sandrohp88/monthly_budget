import { test, expect, type Page, type Locator } from "@playwright/test";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Fire an HTML5 drag from `chip` onto `day` using a shared DataTransfer.
 * Playwright's mouse-based dragTo doesn't reliably trigger native DnD, so we
 * dispatch the drag lifecycle events directly with one DataTransfer handle.
 */
async function dragChipToDay(page: Page, chip: Locator, day: Locator) {
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await chip.dispatchEvent("dragstart", { dataTransfer: dt });
  await day.dispatchEvent("dragover", { dataTransfer: dt });
  await day.dispatchEvent("drop", { dataTransfer: dt });
  await chip.dispatchEvent("dragend", { dataTransfer: dt });
}

test("drag a card-due chip to an earlier day reschedules the payment", async ({ page }) => {
  await ensureAuth(page);

  const today = new Date().toISOString().slice(0, 10);
  const statementDate = addDaysIso(today, -7);
  const dueDate = addDaysIso(today, 7);
  const moveTo = addDaysIso(today, 3);

  const cardResponse = await page.request.post("/api/credit-cards", {
    data: {
      name: "Drag Visa",
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
    { data: { statementDate, dueDate, statementBalanceCents: 500_00 } },
  );
  expect(statementResponse.ok()).toBe(true);

  await page.goto("/calendar");
  if (dueDate.slice(0, 7) !== today.slice(0, 7)) {
    await page.getByRole("button", { name: "Next month" }).click();
  }

  // The card-due chip sits on its due date; drag it to an earlier valid day.
  const chip = page.getByText("Drag Visa payment", { exact: false }).first();
  await expect(chip).toBeVisible();
  const targetDay = page
    .getByText(String(Number(moveTo.slice(8, 10))), { exact: true })
    .first();
  await dragChipToDay(page, chip, targetDay);

  await expect(page.getByText(/card payment plan saved/i)).toBeVisible();

  // The payment now lives on the earlier day as a planned card payment.
  await page.getByText("Drag Visa planned payment").first().click();
  const movedDialog = page.getByRole("dialog");
  await expect(movedDialog.getByText("Drag Visa planned payment").first()).toBeVisible();
  await expect(movedDialog.getByText(/\$500\.00/).first()).toBeVisible();
});
