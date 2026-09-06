import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, it } from "vitest";

it("preserves legacy history, opts recent plans in once, and tracks all new plans", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE credit_card_payment_overrides (id TEXT, due_date TEXT, amount_cents INTEGER);
      INSERT INTO credit_card_payment_overrides VALUES ('old', date('now', '-13 days'), 100),
        ('recent', date('now', '-12 days'), 200), ('future', date('now', '+5 days'), 300);`);
    db.exec(readFileSync(new URL("./db/migrations/0040_track_planned_payment_posting.sql", import.meta.url), "utf8"));
    expect(db.prepare("SELECT id, track_posting FROM credit_card_payment_overrides ORDER BY id").all()).toEqual([
      { id: "future", track_posting: 1 }, { id: "old", track_posting: 0 }, { id: "recent", track_posting: 1 },
    ]);
    db.exec("INSERT INTO credit_card_payment_overrides (id, due_date, amount_cents) VALUES ('new', '2020-01-01', 400)");
    expect(db.prepare("SELECT track_posting FROM credit_card_payment_overrides WHERE id='new'").get()).toEqual({ track_posting: 1 });
    expect(db.prepare("SELECT sum(amount_cents) cents FROM credit_card_payment_overrides").get()).toEqual({ cents: 1000 });
  } finally { db.close(); }
});
