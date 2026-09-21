import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __resetDbCacheForTests, getRawSqlite, runMigrations } from "./client";

// Review 2026-09-21 R03 and the 2026-09-21 production incident: a tracking
// row with a wrong created_at made Drizzle skip migration 0041 silently.

const MIGRATIONS = path.resolve("lib/db/migrations");
const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ tag: string; when: number }>;
};
const last = journal.entries[journal.entries.length - 1]!;

let dir: string;
function openFresh(name = "test.db") {
  __resetDbCacheForTests();
  process.env.DATABASE_URL = `file:${path.join(dir, name)}`;
  return getRawSqlite();
}
function trackingCount(): number {
  return (getRawSqlite().prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as { n: number }).n;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-migrate-"));
});
afterEach(() => {
  __resetDbCacheForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runMigrations", () => {
  it("migrates a fresh database and verifies every journal entry", () => {
    openFresh();
    expect(() => runMigrations()).not.toThrow();
    expect(trackingCount()).toBe(journal.entries.length);
    expect(() => runMigrations()).not.toThrow();
  });

  it("fails loudly when a too-new tracking row makes Drizzle skip a migration", () => {
    const sqlite = openFresh();
    runMigrations();
    // Replicate production: the latest migration's row is gone and an older
    // row carries a Date.now()-style timestamp.
    sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?").run(last.when);
    const older = journal.entries[journal.entries.length - 2]!;
    sqlite.prepare("UPDATE __drizzle_migrations SET created_at = 1788725376900 WHERE created_at = ?").run(older.when);
    openFresh();
    expect(() => runMigrations()).toThrow(
      new RegExp(`${last.tag} was not applied[\\s\\S]*rowid \\d+ has created_at 1788725376900`),
    );
  });

  it("accepts tracking hashes recorded from CRLF checkouts", () => {
    const sqlite = openFresh();
    runMigrations();
    const update = sqlite.prepare("UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?");
    for (const e of journal.entries) {
      const lf = fs.readFileSync(path.join(MIGRATIONS, `${e.tag}.sql`), "utf8").replace(/\r\n/g, "\n");
      update.run(crypto.createHash("sha256").update(lf.replace(/\n/g, "\r\n")).digest("hex"), e.when);
    }
    openFresh();
    expect(() => runMigrations()).not.toThrow();
  });

  it("does not paper over a failing migration by marking everything applied", () => {
    // Astra's probe: schema from 0000 plus a column a later migration adds,
    // with only 0000 tracked. Drizzle hits "duplicate column name".
    const sqlite = openFresh("partial.db");
    const base = fs.readFileSync(path.join(MIGRATIONS, `${journal.entries[0]!.tag}.sql`), "utf8");
    sqlite.exec(base.split("--> statement-breakpoint").join("\n"));
    sqlite.exec(
      "ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'member';" +
        "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)",
    );
    sqlite
      .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)")
      .run(crypto.createHash("sha256").update(base).digest("hex"), journal.entries[0]!.when);
    expect(() => runMigrations()).toThrow(/Database migration failed[\s\S]*duplicate column name/);
    expect(trackingCount()).toBe(1);
  });
});
