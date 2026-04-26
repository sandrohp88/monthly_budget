import fs from "node:fs";
import path from "node:path";

/**
 * Wipes the test SQLite DB before Playwright starts the web server,
 * so /setup is the entry point on a fresh run.
 */
export default async function globalSetup() {
  const cwd = process.cwd();
  const dataDir = path.resolve(cwd, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  for (const f of ["test.db", "test.db-wal", "test.db-shm"]) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // best effort
      }
    }
  }
}
