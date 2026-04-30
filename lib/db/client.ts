import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import * as schema from "./schema";

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

let cached: { db: DrizzleDb; sqlite: Database.Database } | null = null;

function resolveDbPath(): string {
  const url = process.env.DATABASE_URL ?? "file:./data/budget.db";
  return url.startsWith("file:") ? url.slice("file:".length) : url;
}

export function getDb(): DrizzleDb {
  if (cached) return cached.db;

  const dbPath = resolveDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");

  const db = drizzle(sqlite, { schema });
  cached = { db, sqlite };
  return db;
}

export function getRawSqlite(): Database.Database {
  getDb();
  if (!cached) throw new Error("db not initialized");
  return cached.sqlite;
}

export function runMigrations() {
  getDb();
  if (!cached) throw new Error("db not initialized");
  const migrationsFolder = path.resolve(process.cwd(), "lib/db/migrations");
  if (!fs.existsSync(migrationsFolder)) return;
  try {
    migrate(cached.db, { migrationsFolder });
  } catch (err) {
    // SQLite doesn't support ADD COLUMN IF NOT EXISTS, so when a migration
    // that adds a column runs against a DB that already has the column
    // (typically after the same migration was applied previously but the
    // tracking row wasn't durably committed), we self-heal by marking every
    // journal entry as applied using Drizzle's expected hash format
    // (SHA256 of the raw migration file bytes).
    const msg = (err as Error).message ?? "";
    if (!msg.includes("duplicate column name")) throw err;
    selfHealMigrationTracking(migrationsFolder);
  }
}

function selfHealMigrationTracking(migrationsFolder: string) {
  if (!cached) return;
  const sqlite = cached.sqlite;
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS __drizzle_migrations " +
      "(id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at INTEGER)"
  );

  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) return;

  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ tag: string }>;
  };

  const existing = new Set(
    sqlite
      .prepare("SELECT hash FROM __drizzle_migrations")
      .all()
      .map((r) => (r as { hash: string }).hash)
  );

  const insert = sqlite.prepare(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)"
  );

  for (const entry of journal.entries) {
    const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
    if (!fs.existsSync(sqlPath)) continue;
    const buf = fs.readFileSync(sqlPath);
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    if (!existing.has(hash)) {
      insert.run(hash, Date.now());
    }
  }

  // Promote the earliest user to admin if not already (covers the role migration's UPDATE
  // statement that may have been skipped when ALTER TABLE failed mid-script).
  sqlite
    .prepare(
      "UPDATE users SET role = 'admin' WHERE role = 'member' " +
        "AND id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1) " +
        "AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')"
    )
    .run();
}

export { schema };

/**
 * Test-only: clear the cached singleton + close the underlying SQLite handle
 * so the next getDb() call opens a fresh DB at whatever DATABASE_URL points
 * to. Used by lib/repos.test.ts to spin up an in-memory DB per test.
 *
 * NEVER call this from production code paths.
 */
export function __resetDbCacheForTests(): void {
  if (cached) {
    try {
      cached.sqlite.close();
    } catch {
      // best effort
    }
    cached = null;
  }
}
