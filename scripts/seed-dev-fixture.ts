/**
 * Rebuilds a disposable, realistic dev fixture database — separate from both
 * your real dev data (data/budget.db) and the Playwright test db
 * (data/test.db) — so a calendar/dashboard/credit-card change can be eyeballed
 * in a browser without touching either.
 *
 * Usage:
 *   npm run seed:fixture
 *   (or) npx tsx scripts/seed-dev-fixture.ts
 *
 * Then point the dev server at it:
 *   cp .env.fixture .env.local && npm run dev
 *   rm .env.local   # back to your real dev data
 *
 * Login: dev@fixture.local / dev-fixture-pw1
 *
 * Re-running this script always wipes data/dev-fixture.db* first and rebuilds
 * from scratch, so it's safe to run repeatedly — no accumulating duplicates,
 * no stale state from a previous run. All dates are computed relative to
 * "today" at run time, so the fixture never goes stale.
 */
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "../lib/db/client";
import {
  createOwnerAndDefaults,
  createBill,
  createVariableBill,
  createExtra,
  createAsset,
  createCreditCard,
  createStatement,
  createPromo,
  createPaycheck,
  upsertCreditCardPaymentOverride,
} from "../lib/repos";
import { todayIso, addDaysIso, DEFAULT_TIMEZONE } from "../lib/dates";

// Safe to set after the imports above (hoisted by the module system anyway):
// none of those modules touch the db at import time — only lib/db/client's
// lazily-created connection does, on the first call a function below makes.
const DB_PATH = path.resolve(process.cwd(), "data/dev-fixture.db");
process.env.DATABASE_URL = `file:${DB_PATH.replace(/\\/g, "/")}`;

for (const suffix of ["", "-shm", "-wal"]) {
  const p = DB_PATH + suffix;
  if (fs.existsSync(p)) fs.rmSync(p);
}

async function main() {
  runMigrations();

  const today = todayIso(DEFAULT_TIMEZONE);
  const monthDay = (day: number) => {
    // A same-month anchor date for a recurring bill's day-of-month, clamped
    // so a fixture generated on the 30th doesn't ask for Feb 30.
    const y = Number(today.slice(0, 4));
    const m = Number(today.slice(5, 7));
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${today.slice(0, 8)}${String(Math.min(day, lastDay)).padStart(2, "0")}`;
  };

  console.warn("[seed-dev-fixture] creating owner + settings...");
  const owner = await createOwnerAndDefaults({
    email: "dev@fixture.local",
    password: "dev-fixture-pw1",
    displayName: "Dev Fixture",
    startingBalanceCents: 320_000,
    startingBalanceAsOf: today,
    defaultPaycheckCents: 245_000,
    firstPaydayDate: today,
    payFrequencyDays: 14,
    projectionMonths: 6,
    currency: "USD",
    timezone: DEFAULT_TIMEZONE,
  });
  const userId = owner.id;

  console.warn("[seed-dev-fixture] paychecks...");
  // Biweekly for the projection window (~6 months = ~13 pay periods).
  let payDate = addDaysIso(today, 3);
  for (let i = 0; i < 13; i++) {
    await createPaycheck(userId, {
      payDate,
      amountCents: 245_000,
      note: "Biweekly payroll",
      actualReceived: false,
      actualAmountCents: null,
      actualDate: null,
      settledByDraftId: null,
      isActive: true,
    });
    payDate = addDaysIso(payDate, 14);
  }

  console.warn("[seed-dev-fixture] credit cards...");
  // A healthy card, a near-limit card, and a 0% promo card — covers the
  // utilization bar's green/amber/red range and the promo-drift machinery.
  const everydayVisa = await createCreditCard(userId, {
    name: "Everyday Visa",
    statementDay: 3,
    dueDay: 25,
    currentBalanceCents: 128_000,
    creditLimitCents: 500_000,
  });
  const rewardsMastercard = await createCreditCard(userId, {
    name: "Rewards Mastercard",
    statementDay: 12,
    dueDay: 4,
    currentBalanceCents: 410_000,
    creditLimitCents: 450_000,
  });
  const homeDepotCard = await createCreditCard(userId, {
    name: "Home Depot Card",
    statementDay: 20,
    dueDay: 10,
    currentBalanceCents: 220_000,
    creditLimitCents: 300_000,
  });

  console.warn("[seed-dev-fixture] statements + promo...");
  const visaDueDate = addDaysIso(today, 8);
  await createStatement(everydayVisa.id, {
    statementDate: addDaysIso(today, -22),
    dueDate: visaDueDate,
    dueDateUserOverride: false,
    statementBalanceCents: 128_000,
    minimumPaymentCents: 3_500,
    paidAmountCents: null,
    paidDate: null,
    notes: null,
    settledByDraftId: null,
  });
  // A PREVIOUS visa cycle left unpaid past its due date — surfaces as the
  // OVERDUE marker on today ("was due …", all cover counts as late) and gives
  // the late-payment planner something real to aim at.
  await createStatement(everydayVisa.id, {
    statementDate: addDaysIso(today, -52),
    dueDate: addDaysIso(today, -22),
    dueDateUserOverride: false,
    statementBalanceCents: 90_000,
    minimumPaymentCents: 2_500,
    paidAmountCents: null,
    paidDate: null,
    notes: null,
    settledByDraftId: null,
  });

  const mastercardDueDate = addDaysIso(today, 15);
  await createStatement(rewardsMastercard.id, {
    statementDate: addDaysIso(today, -13),
    dueDate: mastercardDueDate,
    dueDateUserOverride: false,
    statementBalanceCents: 410_000,
    minimumPaymentCents: 12_000,
    paidAmountCents: null,
    paidDate: null,
    notes: null,
    settledByDraftId: null,
  });
  // Scheduled a partial payment — exercises the amber "partly covered" due
  // marker and the draggable payment chip, instead of full/uncovered only.
  await upsertCreditCardPaymentOverride(userId, rewardsMastercard.id, {
    dueDate: mastercardDueDate,
    amountCents: 200_000,
    notes: null,
  });

  const homeDepotDueDate = addDaysIso(today, 3);
  await createStatement(homeDepotCard.id, {
    statementDate: addDaysIso(today, -30),
    dueDate: homeDepotDueDate,
    dueDateUserOverride: false,
    statementBalanceCents: 220_000,
    minimumPaymentCents: 4_400,
    paidAmountCents: null,
    paidDate: null,
    notes: null,
    settledByDraftId: null,
  });
  // No payment scheduled for this one — left as "will accrue interest" (red)
  // so the dashboard's uncovered-due alert and the calendar's red due marker
  // both have something to show.
  await createPromo(userId, homeDepotCard.id, {
    description: "0% APR — Patio furniture",
    originalAmountCents: 180_000,
    remainingAmountCents: 150_000,
    startDate: addDaysIso(today, -60),
    endDate: addDaysIso(today, 300),
    monthlyPaymentCents: null,
    notes: null,
    isActive: true,
    authoritativeSource: null,
  });

  console.warn("[seed-dev-fixture] bills...");
  const bill = (
    name: string,
    category: string,
    amountCents: number,
    day: number,
    opts: { autoPay?: boolean; paidViaCardId?: string | null } = {},
  ) =>
    createBill(userId, {
      name,
      category,
      amountCents,
      intervalMonths: 1,
      anchorDate: monthDay(day),
      autoPay: opts.autoPay ?? false,
      paidViaCardId: opts.paidViaCardId ?? null,
      notes: null,
      matchAlias: null,
      isActive: true,
    });

  await bill("Rent", "Housing", 145_000, 1);
  await bill("Internet", "Utilities", 7_000, 5);
  await bill("Phone", "Utilities", 5_500, 8);
  await bill("Car insurance", "Insurance", 13_200, 12);
  // Charged to a card, not cash — carried by that card's statement instead.
  await bill("Gym membership", "Healthcare", 4_200, 15, {
    autoPay: true,
    paidViaCardId: everydayVisa.id,
  });
  await bill("Streaming subscriptions", "Subscriptions", 2_499, 18, {
    autoPay: true,
    paidViaCardId: rewardsMastercard.id,
  });
  await bill("Student loan", "Debt", 21_000, 22);

  console.warn("[seed-dev-fixture] variable bill + one-time expenses...");
  // Variable bills always land on a card's statement (see
  // replaceVariableBillCards) — there's no cash-only option.
  await createVariableBill(userId, {
    name: "Groceries",
    category: "Food",
    amountCents: 55_000,
    intervalMonths: 1,
    anchorDate: monthDay(3),
    notes: "Estimated — actual varies week to week",
    isActive: true,
    cardIds: [everydayVisa.id],
  });

  await createExtra(userId, {
    date: addDaysIso(today, 9),
    description: "Car repair — brake pads",
    amountCents: 32_000,
    category: "Transportation",
    paidViaCardId: null,
    notes: null,
    isActive: true,
  });
  await createExtra(userId, {
    date: addDaysIso(today, 16),
    description: "Mom's birthday gift",
    amountCents: 6_000,
    category: "Gifts",
    paidViaCardId: null,
    notes: null,
    isActive: true,
  });

  console.warn("[seed-dev-fixture] assets...");
  await createAsset(userId, {
    name: "Emergency fund (savings)",
    valueCents: 1_000_000,
    category: "savings",
    asOfDate: today,
  });
  await createAsset(userId, {
    name: "Car — 2022 Honda Civic",
    valueCents: 1_800_000,
    category: "vehicle",
    asOfDate: today,
  });

  console.warn(
    `[seed-dev-fixture] done — ${DB_PATH}\n` +
      "  login: dev@fixture.local / dev-fixture-pw1\n" +
      "  cash on hand: $3,200.00 · card debt: $7,580.00 (net position: -$4,380.00)",
  );
}

// Not `await main()` — a bare top-level await isn't supported under this
// project's CJS-targeted tsx transform (no "type": "module" in package.json).
main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
