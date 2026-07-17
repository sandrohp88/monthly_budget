import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("record -> pay -> history: a paid statement's state survives into the card's history table", async ({
  page,
}) => {
  await ensureAuth(page);

  const today = new Date().toISOString().slice(0, 10);
  const statementDate = addDaysIso(today, -35);
  const dueDate = addDaysIso(today, -5);

  const cardRes = await page.request.post("/api/credit-cards", {
    data: {
      name: "History Lifecycle Card",
      statementDay: 5,
      statementCycleMode: "calendar_day",
      statementCycleIntervalDays: 31,
      dueDay: 20,
      autoPay: false,
    },
  });
  expect(cardRes.ok()).toBe(true);
  const { card } = (await cardRes.json()) as { card: { id: string } };

  const statementRes = await page.request.post(`/api/credit-cards/${card.id}/statements`, {
    data: {
      statementDate,
      dueDate,
      statementBalanceCents: 275_50,
    },
  });
  expect(statementRes.ok()).toBe(true);
  const { statement } = (await statementRes.json()) as { statement: { id: string } };

  // Mark it paid via the same PATCH the "Mark paid" dialog itself calls.
  // credit-card-statement.spec.ts already walks that dialog end-to-end on a
  // different card — this spec's new value is the history-table
  // verification below, not another pass through the same modal.
  const payRes = await page.request.patch(`/api/credit-cards/statements/${statement.id}`, {
    data: {
      paidAmountCents: 275_50,
      paidDate: dueDate,
    },
  });
  expect(payRes.ok()).toBe(true);

  await page.goto(`/credit-cards/${card.id}`);
  await expect(page.getByRole("heading", { name: /history lifecycle card/i })).toBeVisible();

  // The statement history table lives on this card's own detail page — only
  // this card's statements ever appear here, so scoping to the row carrying
  // our distinctive balance is enough (no other spec's rows can land here).
  const historyRow = page.locator("tr").filter({ hasText: "$275.50" });
  await expect(historyRow).toHaveCount(1);
  await expect(historyRow).toContainText(/paid/i);
  await expect(historyRow).not.toContainText(/unpaid|overdue/i);
});
