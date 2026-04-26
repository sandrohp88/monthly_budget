/**
 * Optional manual seed for development. Creates an owner account if none exists.
 * Usage:
 *   npx tsx scripts/seed.ts admin@example.com "supersecretpw" "Owner"
 */
import { runMigrations } from "../lib/db/client";
import { createOwnerAndDefaults, userExists } from "../lib/repos";

async function main() {
  runMigrations();
  if (await userExists()) {
    console.warn("[seed] owner already exists; skipping");
    return;
  }
  const [, , email, password, displayName] = process.argv;
  if (!email || !password || !displayName) {
    console.error("usage: tsx scripts/seed.ts <email> <password> <displayName>");
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  await createOwnerAndDefaults({
    email,
    password,
    displayName,
    startingBalanceCents: 0,
    defaultPaycheckCents: 0,
    firstPaydayDate: today,
    payFrequencyDays: 14,
    projectionMonths: 6,
    currency: "USD",
    timezone: "America/New_York",
  });
  console.warn(`[seed] created owner ${email}`);
}

await main();
