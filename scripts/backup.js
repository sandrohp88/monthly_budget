#!/usr/bin/env node
// Pure Node fallback for the backup task — uses better-sqlite3's backup() API.
// Useful when you'd rather run `node scripts/backup.js` from cron without
// shelling out to the sqlite3 binary.

import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

const src = process.env.SRC ?? path.resolve(process.cwd(), "data/budget.db");
const destDir = process.env.DEST_DIR ?? path.resolve(process.cwd(), "backups");
const keep = Number(process.env.KEEP ?? 14);

if (!fs.existsSync(src)) {
  console.warn(`[backup] source not found: ${src}`);
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
const out = path.join(destDir, `budget-${stamp}.db`);

const db = new Database(src, { readonly: true });
await db.backup(out);
db.close();
console.warn(`[backup] wrote ${out}`);

const files = fs
  .readdirSync(destDir)
  .filter((f) => f.startsWith("budget-") && f.endsWith(".db"))
  .map((f) => ({ f, t: fs.statSync(path.join(destDir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);

for (const { f } of files.slice(keep)) {
  fs.unlinkSync(path.join(destDir, f));
  console.warn(`[backup] pruned ${f}`);
}
