import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** MM/DD/YYYY, the numeric-date form PayPal's page uses. */
function numericDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

test("paste PayPal promo list -> preview diff -> apply updates and creates promos", async ({
  page,
}) => {
  await ensureAuth(page);

  const today = new Date().toISOString().slice(0, 10);

  const cardRes = await page.request.post("/api/credit-cards", {
    data: {
      name: "Promo Reconcile Card",
      statementDay: 5,
      statementCycleMode: "calendar_day",
      statementCycleIntervalDays: 31,
      dueDay: 20,
      autoPay: false,
    },
  });
  expect(cardRes.ok()).toBe(true);
  const { card } = (await cardRes.json()) as { card: { id: string } };

  // One existing active promo the pasted list should UPDATE by name match.
  const promoRes = await page.request.post(`/api/credit-cards/${card.id}/promos`, {
    data: {
      description: "Temu",
      originalAmountCents: 250_92,
      startDate: addDaysIso(today, -30),
      endDate: addDaysIso(today, 60),
    },
  });
  expect(promoRes.ok()).toBe(true);

  // Synthetic PayPal "Promotional purchases" paste (the stacked block format
  // from the wiki's PayPal notes), dates relative so this never rots:
  // Temu.com matches the seeded promo (update), Brand New Store matches
  // nothing (create).
  const paste = [
    "Temu.com",
    "Remaining balance",
    "$112.45",
    `No interest if paid in full by ${numericDate(addDaysIso(today, 60))}`,
    "",
    "Brand New Store",
    "$55.00",
    `No interest if paid in full by ${numericDate(addDaysIso(today, 180))}`,
  ].join("\n");

  await page.goto(`/credit-cards/${card.id}`);
  await page.getByRole("button", { name: /reconcile/i }).click();

  const dialog = page.getByRole("dialog", { name: /reconcile from issuer list/i });
  await expect(dialog).toBeVisible();
  await dialog.locator("#promo-list-text").fill(paste);

  // Preview renders from the same parser/matcher the server uses.
  await expect(dialog.getByText("// UPDATE (1)")).toBeVisible();
  const updateRow = dialog.locator("div").filter({ hasText: /^Temu\$250\.92/ });
  await expect(updateRow).toContainText("$112.45");
  await expect(dialog.getByText("// CREATE (1)")).toBeVisible();
  // span-scoped: the raw paste text inside the textarea also matches by value.
  await expect(dialog.locator("span").filter({ hasText: /^Brand New Store$/ })).toBeVisible();
  // The seeded promo matched a pasted row, so nothing is up for archiving.
  await expect(dialog.getByText(/not in list/i)).toHaveCount(0);

  await dialog.getByRole("button", { name: /apply 2 rows/i }).click();
  await expect(dialog).toBeHidden();

  // Applied state survives a full reload: the new promo joins the list and
  // the promos "Remaining" summary reflects $112.45 + $55.00.
  await page.goto(`/credit-cards/${card.id}`);
  await expect(page.getByRole("listitem").filter({ hasText: "Brand New Store" })).toHaveCount(1);
  await expect(page.getByRole("listitem").filter({ hasText: "Temu" })).toHaveCount(1);
  await expect(page.getByText("$167.45").first()).toBeVisible();
});
