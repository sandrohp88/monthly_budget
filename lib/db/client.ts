import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import * as schema from "./schema";

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

let cached: { db: DrizzleDb; sqlite: Database.Database } | null = null;

export function resolveDbPath(): string {
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

type JournalEntry = { idx: number; tag: string; when: number };

/**
 * Set once migrations have run and been verified in this process. Migrations
 * only change with a deploy (a new process), so later calls are free.
 */
let migrationsVerified = false;

/**
 * Apply pending migrations, then prove every journal entry is recorded.
 *
 * Why the proof: Drizzle decides what to run by timestamp alone. It applies
 * only journal entries whose `when` is newer than the newest
 * `__drizzle_migrations.created_at`. A tracking row with a wrong timestamp
 * (e.g. `Date.now()` written by a manual fix) makes every later migration be
 * skipped silently, and the app then fails at query time on a missing column.
 * That is how 0041 was skipped in production on 2026-09-21 (review R03).
 *
 * There is deliberately no automatic repair. The old "self-heal" marked every
 * journal entry applied without running or checking its SQL. Drift is a clear
 * startup failure; the fix is a deliberate, verified repair (see CLAUDE.md §7).
 */
export function runMigrations() {
  getDb();
  if (!cached) throw new Error("db not initialized");
  if (migrationsVerified) return;
  const migrationsFolder = path.resolve(process.cwd(), "lib/db/migrations");
  if (!fs.existsSync(migrationsFolder)) return;
  try {
    migrate(cached.db, { migrationsFolder });
  } catch (err) {
    // Drizzle wraps the SQLite error; surface the real cause.
    const e = err as Error & { cause?: unknown };
    const cause = e.cause instanceof Error ? ` (cause: ${e.cause.message})` : "";
    throw new Error(`Database migration failed: ${e.message}${cause}`, { cause: err });
  }
  const problems = diagnoseMigrationTracking(cached.sqlite, migrationsFolder);
  if (problems.length > 0) {
    throw new Error(`Database migrations are out of sync:\n- ${problems.join("\n- ")}`);
  }
  migrationsVerified = true;
}

/** Drizzle's hash: SHA-256 of the migration file bytes. */
function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Compare the journal with `__drizzle_migrations`. Returns one message per
 * journal entry that has no tracking row, plus a hint naming any tracking row
 * whose timestamp would make Drizzle skip it. Empty means in sync.
 *
 * Hashes are compared with LF and CRLF line endings, because deploys from
 * Windows and Linux checkouts record different bytes for the same migration.
 */
export function diagnoseMigrationTracking(
  sqlite: Database.Database,
  migrationsFolder: string,
): string[] {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: JournalEntry[] };
  const rows = sqlite
    // rowid, not id: Drizzle declares `id SERIAL PRIMARY KEY`, which SQLite
    // does not treat as an integer rowid alias, so `id` is NULL on every row.
    .prepare("SELECT rowid AS rowid, hash, created_at AS createdAt FROM __drizzle_migrations")
    .all() as Array<{ rowid: number; hash: string; createdAt: number }>;
  const tracked = new Set(rows.map((r) => r.hash));

  const missing = journal.entries.filter((entry) => {
    const lf = fs.readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), "utf8").replace(/\r\n/g, "\n");
    return !tracked.has(sha256(lf)) && !tracked.has(sha256(lf.replace(/\n/g, "\r\n")));
  });
  if (missing.length === 0) return [];

  const problems = missing.map((m) => `${m.tag} was not applied`);
  const firstMissing = Math.min(...missing.map((m) => m.when));
  const blockers = rows.filter((r) => r.createdAt >= firstMissing);
  for (const r of blockers) {
    problems.push(
      `__drizzle_migrations rowid ${r.rowid} has created_at ${r.createdAt}, newer than ` +
        `${missing[0]!.tag} (${firstMissing}); Drizzle skips migrations older than the ` +
        `newest row. Set that row's created_at to its own journal "when", then restart.`,
    );
  }
  return problems;
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
  migrationsVerified = false;
  if (cached) {
    try {
      cached.sqlite.close();
    } catch {
      // best effort
    }
    cached = null;
  }
}
