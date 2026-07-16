import { test, expect, type Page, type Locator } from "@playwright/test";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The month-grid day cell (role=button) whose text starts with the day number. */
function dayCell(page: Page, iso: string): Locator {
  return page
    .getByRole("button")
    .filter({ hasText: new RegExp(`^${Number(iso.slice(8, 10))}\\b`) })
    .first();
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

test("drag a planned card payment to an earlier day reschedules it", async ({ page }) => {
  await ensureAuth(page);

  const today = new Date().toISOString().slice(0, 10);
  const statementDate = addDaysIso(today, -7);
  const dueDate = addDaysIso(today, 8);
  const planDate = addDaysIso(today, 5);
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

  // Due markers are informational since PR #88 and can't be dragged — the
  // draggable chip is a planned payment, so seed one via the overrides API.
  const overrideResponse = await page.request.put(
    `/api/credit-cards/${card.id}/payment-overrides`,
    { data: { dueDate: planDate, amountCents: 200_00 } },
  );
  expect(overrideResponse.ok()).toBe(true);

  await page.goto("/calendar");
  if (planDate.slice(0, 7) !== today.slice(0, 7)) {
    await page.getByRole("button", { name: "Next month" }).click();
  }

  const chip = page.getByText("Drag Visa planned payment").first();
  await expect(chip).toBeVisible();
  await dragChipToDay(page, chip, dayCell(page, moveTo));

  await expect(page.getByText(/card payment scheduled/i)).toBeVisible();

  // The payment now lives on the earlier day as a planned card payment.
  await expect(dayCell(page, moveTo)).toContainText("Drag Visa planned payment");
  await dayCell(page, moveTo).getByText("Drag Visa planned payment").click();
  const movedDialog = page.getByRole("dialog");
  await expect(movedDialog.getByText("Drag Visa planned payment").first()).toBeVisible();
  await expect(movedDialog.getByText(/\$200\.00/).first()).toBeVisible();
});
