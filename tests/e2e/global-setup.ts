import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Wipes the test SQLite DB before Playwright starts the web server, so /setup
 * is the entry point on a fresh run.
 *
 * On Windows the dev server can hold a file lock on test.db, making
 * fs.unlinkSync silently fail. So we open the DB and TRUNCATE every user
 * table directly — works even if another process has the file open in WAL
 * mode. If the file doesn't exist yet, we just create the dir.
 */
export default async function globalSetup() {
  const cwd = process.cwd();
  const dataDir = path.resolve(cwd, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, "test.db");
  if (!fs.existsSync(dbPath)) return; // first run — server will create it.

  let sqlite: Database.Database | null = null;
  try {
    sqlite = new Database(dbPath);
    // Discover every user-created table (not sqlite_* internals nor the
    // drizzle migrations log).
    const rows = sqlite
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table'
         AND name NOT LIKE 'sqlite_%'
         AND name <> '__drizzle_migrations'`,
      )
      .all() as Array<{ name: string }>;
    sqlite.pragma("foreign_keys = OFF");
    for (const r of rows) {
      sqlite.exec(`DELETE FROM \`${r.name}\``);
    }
    sqlite.pragma("foreign_keys = ON");
    // Also clear migration tracking so the server re-runs them on boot.
    // (idempotent; the schema rows are gone but tables still exist.)
  } catch (err) {
    console.warn(`[global-setup] could not wipe test.db: ${(err as Error).message}`);
  } finally {
    sqlite?.close();
  }
}
