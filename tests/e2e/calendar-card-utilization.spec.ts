import path from "node:path";
import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { ensureAuth } from "./auth";

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const WITH_LIMIT = "Utilization Card";
const NO_LIMIT = "No Limit Card";

/**
 * Two manual cards with a recorded statement each, so both produce a card due
 * marker on the calendar. One has a credit line, the other doesn't — the bar
 * must appear for the first and stay absent (not render 0%) for the second.
 */
function seedCards(dbPath: string, dueDate: string) {
  const db = new Database(dbPath);
  try {
    const user = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string } | undefined;
    if (!user) throw new Error("No user found — run ensureAuth first");
    const userId = user.id;
    if (db.prepare("SELECT id FROM credit_cards WHERE id = ?").get("util-card-1")) return;

    db.pragma("foreign_keys = OFF");
    const statementDate = addDaysIso(dueDate, -20);
    const insertCard = db.prepare(
      `INSERT OR IGNORE INTO credit_cards
       (id, user_id, name, statement_day, statement_cycle_mode, statement_cycle_interval_days,
        due_day, grace_period_days, current_balance_cents, credit_limit_cents,
        auto_pay, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'calendar_day', 31, ?, 14, ?, ?, 0, 1, ?, ?)`,
    );
    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO credit_card_statements
       (id, card_id, statement_date, due_date, due_date_user_override,
        statement_balance_cents, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    );

    // 800.00 balance against a 1,000.00 line -> 80%, the "Running high" band.
    insertCard.run(
      "util-card-1", userId, WITH_LIMIT,
      Number(statementDate.slice(8, 10)), Number(dueDate.slice(8, 10)),
      80000, 100000, Date.now(), Date.now(),
    );
    insertStmt.run("util-stmt-1", "util-card-1", statementDate, dueDate, 25000, Date.now());

    insertCard.run(
      "util-card-2", userId, NO_LIMIT,
      Number(statementDate.slice(8, 10)), Number(dueDate.slice(8, 10)),
      40000, null, Date.now(), Date.now(),
    );
    insertStmt.run("util-stmt-2", "util-card-2", statementDate, dueDate, 15000, Date.now());

    db.pragma("foreign_keys = ON");
  } finally {
    db.close();
  }
}

test("calendar card events show the utilization bar and limit", async ({ page }) => {
  await ensureAuth(page);

  // A due date ~10 days out keeps the marker inside the projection window and
  // on the current month's grid in the common case.
  const today = new Date().toISOString().slice(0, 10);
  const dueDate = addDaysIso(today, 10);
  seedCards(path.resolve(process.cwd(), "data", "test.db"), dueDate);

  await page.goto("/calendar");

  // The grid opens on today's month; a due date 10 days out can land in the
  // next one, and clicking a bare day number would otherwise hit the same
  // numbered cell of the wrong month.
  if (dueDate.slice(0, 7) !== today.slice(0, 7)) {
    await page.getByRole("button", { name: "Next month" }).click();
  }

  const day = String(Number(dueDate.slice(8, 10)));
  const dayCell = page.getByRole("button", { name: new RegExp(`^${day}\\b`) }).first();

  // Inline, on the month grid itself — the chip carries the percentage and a
  // tooltip with the full figures, without needing the day dialog opened.
  await expect(dayCell.getByText("80%", { exact: true })).toBeVisible();
  await expect(
    dayCell.locator(`[title*="80% used · $800.00 of $1,000.00"]`),
  ).toHaveCount(1);
  // The limit-less card's chip stays bare — exactly one percentage on this day.
  await expect(dayCell.getByText(/^\d+(\.\d)?%$/)).toHaveCount(1);

  await dayCell.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(WITH_LIMIT).first()).toBeVisible();

  // 800 of 1,000 -> 80% used, 200 of headroom.
  await expect(dialog.getByText("80% used")).toBeVisible();
  await expect(dialog.getByText("$800.00 of $1,000.00")).toBeVisible();
  await expect(dialog.getByText(/\$200\.00 left before the limit/)).toBeVisible();

  // The card with no credit line renders no bar at all — never "0% used".
  // `exact` matters here: the default substring match would find "0% used"
  // inside the other card's "80% used".
  await expect(dialog.getByText(NO_LIMIT).first()).toBeVisible();
  await expect(dialog.getByText("0% used", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(/of \$0\.00/)).toHaveCount(0);
  // Exactly one bar in the dialog — the limit-less card contributed none.
  await expect(dialog.getByText(/% used$/)).toHaveCount(1);
});
