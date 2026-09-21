import { test, expect } from "@playwright/test";
import { ensureAuth } from "./auth";

// Review 2026-09-21 R06: card-payment moves are one server transaction.
test("card payment batch: moves atomically, rejects collisions and rolls back", async ({ page }) => {
  await ensureAuth(page);
  const cardRes = await page.request.post("/api/credit-cards", {
    data: { name: `Batch Card ${Date.now()}`, statementDay: 3, statementCycleMode: "calendar_day", statementCycleIntervalDays: 31, dueDay: 28, autoPay: false },
  });
  expect(cardRes.ok()).toBe(true);
  const { card } = (await cardRes.json()) as { card: { id: string } };
  const batch = (ops: unknown[]) =>
    page.request.post("/api/credit-cards/payment-overrides/batch", { data: { ops } });

  expect((await batch([
    { op: "put", cardId: card.id, dueDate: "2027-01-10", amountCents: 1000, notes: null },
    { op: "put", cardId: card.id, dueDate: "2027-01-20", amountCents: 2000, notes: null },
  ])).ok()).toBe(true);

  // Move 01-10 onto the occupied 01-20: conflict, and the delete is rolled back.
  const collide = await batch([
    { op: "delete", cardId: card.id, dueDate: "2027-01-10", mustExist: true },
    { op: "put", cardId: card.id, dueDate: "2027-01-20", amountCents: 1000, notes: null },
  ]);
  expect(collide.status()).toBe(409);

  // The untouched 01-10 row can still be moved, which proves it survived.
  const move = await batch([
    { op: "delete", cardId: card.id, dueDate: "2027-01-10", mustExist: true },
    { op: "put", cardId: card.id, dueDate: "2027-01-15", amountCents: 1000, notes: null },
  ]);
  expect(move.ok()).toBe(true);

  // Repeating the same move is now stale: its source is gone.
  expect((await batch([
    { op: "delete", cardId: card.id, dueDate: "2027-01-10", mustExist: true },
    { op: "put", cardId: card.id, dueDate: "2027-01-16", amountCents: 1000, notes: null },
  ])).status()).toBe(409);

  expect((await batch([{ op: "delete", cardId: "no-such-card", dueDate: "2027-01-15" }])).status()).toBe(404);
});
