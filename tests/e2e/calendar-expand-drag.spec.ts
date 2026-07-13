import { test, expect, type Page, type Locator } from "@playwright/test";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function dragChipToDay(page: Page, chip: Locator, day: Locator) {
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await chip.dispatchEvent("dragstart", { dataTransfer: dt });
  await day.dispatchEvent("dragover", { dataTransfer: dt });
  await day.dispatchEvent("drop", { dataTransfer: dt });
  await chip.dispatchEvent("dragend", { dataTransfer: dt });
}

test("a payment hidden behind +N MORE can be revealed and dragged", async ({ page }) => {
  await ensureAuth(page);

  const today = new Date().toISOString().slice(0, 10);
  const statementDate = addDaysIso(today, -7);
  const dueDate = addDaysIso(today, 7);
  const moveTo = addDaysIso(today, 3);

  const cardRes = await page.request.post("/api/credit-cards", {
    data: {
      name: "Expand Visa",
      statementDay: Number(statementDate.slice(8, 10)),
      statementCycleMode: "calendar_day",
      statementCycleIntervalDays: 31,
      dueDay: Number(dueDate.slice(8, 10)),
      currentBalanceCents: 500_00,
      autoPay: false,
    },
  });
  expect(cardRes.ok()).toBe(true);
  const { card } = (await cardRes.json()) as { card: { id: string } };

  await page.request.post(`/api/credit-cards/${card.id}/statements`, {
    data: { statementDate, dueDate, statementBalanceCents: 500_00 },
  });

  // Three bills on the card's due date push the card-payment chip (an "extra",
  // ordered last) past the 3-chip cap, so it starts hidden behind "+N MORE".
  for (const name of ["Bill A", "Bill B", "Bill C"]) {
    await page.request.post("/api/bills", {
      data: { name, category: "Utilities", amountCents: 10_00, intervalMonths: 1, anchorDate: dueDate, autoPay: false },
    });
  }

  await page.goto("/calendar");
  if (dueDate.slice(0, 7) !== today.slice(0, 7)) {
    await page.getByRole("button", { name: "Next month" }).click();
  }

  // The card-payment chip is hidden initially.
  await expect(page.getByText("Expand Visa payment", { exact: false })).toHaveCount(0);

  // Expand the busy day. Exact name so we hit the inner "+1 MORE" button, not
  // the day cell (also role=button) whose accessible name contains that text.
  await page.getByRole("button", { name: "+1 MORE", exact: true }).click();

  // Expanding must NOT open the day-detail dialog.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The "+N MORE" collapses into "SHOW LESS" once expanded.
  await expect(page.getByRole("button", { name: "SHOW LESS", exact: true })).toBeVisible();

  // The previously-hidden card payment is now a draggable chip. Target the
  // draggable element (not the day cell, which also contains this text).
  const chip = page.locator('[draggable="true"]').filter({ hasText: "Expand Visa payment" });
  await expect(chip).toBeVisible();
  const targetDay = page.getByText(String(Number(moveTo.slice(8, 10))), { exact: true }).first();
  await dragChipToDay(page, chip, targetDay);
  await expect(page.getByText(/card payment plan saved/i)).toBeVisible();
});
