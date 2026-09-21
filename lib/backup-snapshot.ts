import fs from "node:fs";
import path from "node:path";
import { resolveDbPath } from "./db/client";
import { exportAll } from "./repos";

/** Pre-import snapshots kept per user; older ones are pruned. */
const KEEP_PER_USER = 5;

export function snapshotDir(): string {
  return path.join(path.dirname(resolveDbPath()), "pre-import");
}

/**
 * Write the user's current data (same shape as the JSON export) next to the
 * database before a restore replaces it, so a mistaken import is recoverable
 * by re-importing this file. Lives in the DB's data volume, which the daily
 * backup container already treats as private.
 *
 * Returns the snapshot's file name. Throws if it can't be written — the
 * caller must NOT proceed with a destructive import without it.
 */
export async function writePreImportSnapshot(userId: string, now = new Date()): Promise<string> {
  const dir = snapshotDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const name = `${userId}-${stamp}.json`;
  const data = await exportAll(userId);
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data), { mode: 0o600 });

  const mine = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${userId}-`) && f.endsWith(".json"))
    .sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_PER_USER))) {
    fs.rmSync(path.join(dir, old), { force: true });
  }
  return name;
}
