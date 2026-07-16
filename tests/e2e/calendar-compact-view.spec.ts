import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("compact view lists only event-days across three months and stays interactive", async ({
  page,
}) => {
  await ensureAuth(page);

  const today = new Date().toISOString().slice(0, 10);
  // Two paydays 14 days apart so the compact view spans more than one pay
  // cycle — the second payday opens a new cycle band.
  const firstPay = addDaysIso(today, 1);
  const secondPay = addDaysIso(today, 15);
  // A bill between the two paydays — an expense-day inside the first cycle.
  const billDue = addDaysIso(today, 5);

  for (const payDate of [firstPay, secondPay]) {
    const res = await page.request.post("/api/paychecks", {
      data: { payDate, amountCents: 2200_00 },
    });
    expect(res.ok()).toBe(true);
  }

  const billRes = await page.request.post("/api/bills", {
    data: {
      name: "Compact Rent",
      category: "Housing",
      amountCents: 1200_00,
      intervalMonths: 1,
      anchorDate: billDue,
      autoPay: false,
    },
  });
  expect(billRes.ok()).toBe(true);

  await page.goto("/calendar");
  await page.getByRole("button", { name: "compact", exact: true }).click();

  // The header shows a three-month range (e.g. "JUL – SEP 2026").
  await expect(page.getByText("–", { exact: false }).first()).toBeVisible();

  // Seeded events render as event-day rows…
  await expect(page.getByText("Compact Rent").first()).toBeVisible();
  await expect(page.getByText("Paycheck").first()).toBeVisible();

  // …and the paycheck-cycle legend is shown only in the compact view.
  const cycleLegend = page.getByText("TINT SWITCHES AT EACH PAYDAY");
  await expect(cycleLegend).toBeVisible();

  // Clicking an event-day opens the same day-detail dialog the other views use.
  await page.getByText("Compact Rent").first().click();
  const dayDialog = page.getByRole("dialog");
  await expect(dayDialog.getByText("Compact Rent")).toBeVisible();
  await expect(dayDialog.getByText(/\$1,200\.00/).first()).toBeVisible();
  // Two "Close" buttons share the dialog (footer + the corner X) — take the first.
  await dayDialog.getByRole("button", { name: "Close", exact: true }).first().click();

  // Switching back to the month view hides the compact-only cycle legend.
  await page.getByRole("button", { name: "month", exact: true }).click();
  await expect(cycleLegend).toHaveCount(0);
});
