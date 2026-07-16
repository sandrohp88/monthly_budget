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

async function dragChipToDay(page: Page, chip: Locator, day: Locator) {
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await chip.dispatchEvent("dragstart", { dataTransfer: dt });
  await day.dispatchEvent("dragover", { dataTransfer: dt });
  await day.dispatchEvent("drop", { dataTransfer: dt });
  await chip.dispatchEvent("dragend", { dataTransfer: dt });
}

test("a payment hidden behind +N more can be revealed and dragged", async ({ page }) => {
  await ensureAuth(page);

  const today = new Date().toISOString().slice(0, 10);
  const statementDate = addDaysIso(today, -7);
  const dueDate = addDaysIso(today, 9);
  const moveTo = addDaysIso(today, 4);

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

  // A planned payment ON the due date — the draggable chip (due markers are
  // informational since PR #88 and can't be dragged).
  const overrideRes = await page.request.put(
    `/api/credit-cards/${card.id}/payment-overrides`,
    { data: { dueDate, amountCents: 500_00 } },
  );
  expect(overrideRes.ok()).toBe(true);

  // Three bills on the same day fill the 3-chip cap; the card chips (extras
  // sort after bills) start hidden behind "+N more".
  for (const name of ["Bill A", "Bill B", "Bill C"]) {
    await page.request.post("/api/bills", {
      data: { name, category: "Utilities", amountCents: 10_00, intervalMonths: 1, anchorDate: dueDate, autoPay: false },
    });
  }

  await page.goto("/calendar");
  if (dueDate.slice(0, 7) !== today.slice(0, 7)) {
    await page.getByRole("button", { name: "Next month" }).click();
  }

  // The planned-payment chip is hidden initially.
  await expect(page.getByText("Expand Visa planned payment")).toHaveCount(0);

  // Expand the busy day. Scope to its cell (other specs share the per-run DB
  // and may overflow other days); the anchored shape-match skips the day cell
  // itself (also role=button) whose accessible name contains this text.
  await dayCell(page, dueDate).getByRole("button", { name: /^\+\d+ more$/ }).click();

  // Expanding must NOT open the day-detail dialog.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The "+N more" collapses into "Show less" once expanded.
  await expect(page.getByRole("button", { name: "Show less", exact: true })).toBeVisible();

  // The previously-hidden planned payment is now a draggable chip. Target the
  // draggable element (not the day cell, which also contains this text).
  const chip = page.locator('[draggable="true"]').filter({ hasText: "Expand Visa planned payment" });
  await expect(chip).toBeVisible();
  await dragChipToDay(page, chip, dayCell(page, moveTo));
  await expect(page.getByText(/card payment scheduled/i)).toBeVisible();
});
