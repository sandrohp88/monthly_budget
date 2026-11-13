import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** "$1,234.56", "-$1,234.56", "+$1.00", "−$1.00" → signed cents. */
function parseCents(text: string): number {
  const t = text.trim();
  const negative = /^[-−]/.test(t) || t.includes("-$");
  const value = Math.round(Number(t.replace(/[^0-9.]/g, "")) * 100);
  return negative ? -value : value;
}

async function sidebarDeltaCents(page: Page): Promise<number> {
  return parseCents(await page.getByTestId("sidebar-delta-30d").innerText());
}

async function availableToPlanCents(page: Page): Promise<number> {
  const tile = page.getByText("Available to plan", { exact: true }).first().locator("xpath=../..");
  return parseCents(await tile.locator(".tabular").first().innerText());
}

/** Linked starting-balance accounts left by other specs would override the manual balance. */
function setLinkedStartingBalance(ids: string[] | null): string[] {
  const db = new Database(path.resolve("data/test.db"));
  try {
    if (ids === null) {
      const rows = db
        .prepare("SELECT id FROM plaid_accounts WHERE use_as_starting_balance = 1")
        .all() as Array<{ id: string }>;
      db.prepare("UPDATE plaid_accounts SET use_as_starting_balance = 0 WHERE use_as_starting_balance = 1").run();
      db.pragma("wal_checkpoint(TRUNCATE)");
      return rows.map((r) => r.id);
    }
    const restore = db.prepare("UPDATE plaid_accounts SET use_as_starting_balance = 1 WHERE id = ?");
    for (const id of ids) restore.run(id);
    db.pragma("wal_checkpoint(TRUNCATE)");
    return ids;
  } finally {
    db.close();
  }
}

const AMOUNT_CENTS = 1357_91;
const BALANCE_STEP_CENTS = 2468_10;

/**
 * Review 2026-11-10 DATA-2/DATA-3. A client fetch() does not invalidate
 * Next's client router cache. (a) The shared (app) layout renders the sidebar
 * projection summary and is not re-rendered on client navigation, so after a
 * bill archive the sidebar kept the old 30-day delta on every page. (b) Back
 * restored the dashboard payload cached before a settings save. Every client
 * mutation now ends in refreshAfterMutation() (CLAUDE.md §17).
 *
 * The spec navigates IMMEDIATELY after each success toast, on purpose: a
 * navigation discards a pending router.refresh(), and the helper must still
 * leave the destination and the layout fresh. Do not add waits here.
 */
test("bill and settings writes refresh the sidebar and the cached dashboard", async ({ page }) => {
  await ensureAuth(page);

  const current = (await (await page.request.get("/api/settings")).json()) as {
    settings: {
      startingBalanceCents: number;
      startingBalanceAsOf: string;
      defaultPaycheckCents: number;
      firstPaydayDate: string;
      payFrequencyDays: number;
      projectionMonths: number;
      currency: string;
      timezone: string;
    };
  };
  const s = current.settings;
  const original = {
    startingBalanceCents: s.startingBalanceCents,
    startingBalanceAsOf: s.startingBalanceAsOf,
    defaultPaycheckCents: s.defaultPaycheckCents,
    firstPaydayDate: s.firstPaydayDate,
    payFrequencyDays: s.payFrequencyDays,
    projectionMonths: s.projectionMonths,
    currency: s.currency,
    timezone: s.timezone,
  };
  const today = new Date().toISOString().slice(0, 10);
  const linkedIds = setLinkedStartingBalance(null);
  let billId: string | null = null;

  try {
    // Manual mode from yesterday, so the sidebar's 30-day window holds the bill.
    const anchored = await page.request.patch("/api/settings", {
      data: { ...original, startingBalanceAsOf: addDaysIso(today, -1) },
    });
    expect(anchored.ok()).toBeTruthy();

    const name = `E2E-REFRESH-${Date.now()}`;
    const created = await page.request.post("/api/bills", {
      data: { name, category: "Other", amountCents: AMOUNT_CENTS, intervalMonths: 1, anchorDate: addDaysIso(today, 5) },
    });
    expect(created.ok()).toBeTruthy();
    billId = ((await created.json()) as { bill: { id: string } }).bill.id;

    // (a) Sidebar: archive on /bills, then a client navigation to /calendar.
    await page.goto("/");
    const deltaBefore = await sidebarDeltaCents(page);

    const sidebar = page.locator("aside");
    await sidebar.getByRole("link", { name: /^bills/i }).click();
    await page.waitForURL("**/bills");
    await page.locator("tr").filter({ hasText: name }).click();
    await page.getByRole("button", { name: /soft delete/i }).click();
    await expect(page.getByText(/bill archived/i)).toBeVisible();

    await sidebar.getByRole("link", { name: /^calendar/i }).click();
    await page.waitForURL("**/calendar");
    await expect.poll(() => sidebarDeltaCents(page)).toBe(deltaBefore + AMOUNT_CENTS);

    // (b) Back: the dashboard cached before a settings save must not come back.
    await sidebar.getByRole("link", { name: /^dashboard/i }).click();
    await page.waitForURL((url) => new URL(url).pathname === "/");
    const availableBefore = await availableToPlanCents(page);

    await sidebar.getByRole("link", { name: /^settings/i }).click();
    await page.waitForURL("**/settings");
    const balanceInput = page.locator("#settings-starting-balance");
    await balanceInput.fill(((original.startingBalanceCents + BALANCE_STEP_CENTS) / 100).toFixed(2));
    await page.getByRole("button", { name: /save settings/i }).click();
    await expect(page.getByText(/settings saved/i)).toBeVisible();

    await page.goBack();
    await page.waitForURL((url) => new URL(url).pathname === "/");
    await expect.poll(() => availableToPlanCents(page)).toBe(availableBefore + BALANCE_STEP_CENTS);
  } finally {
    await page.request.patch("/api/settings", { data: original });
    if (billId) await page.request.delete(`/api/bills/${billId}`);
    setLinkedStartingBalance(linkedIds);
  }
});
