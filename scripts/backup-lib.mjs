// Pure helpers for scripts/backup.js. Naming and retention match backup.sh:
// nightly files are budget-YYYYMMDD-HHMMSS.db; nothing else is ever pruned.

export const NIGHTLY_PATTERN = /^budget-\d{8}-\d{6}\.db$/;

/** budget-YYYYMMDD-HHMMSS.db from the LOCAL clock, like `date +%Y%m%d-%H%M%S` in backup.sh. */
export function backupFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
  const time = `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `budget-${day}-${time}.db`;
}

/** Names of nightly backups beyond the newest `keep`. Other names are never returned. */
export function selectNightlyToPrune(names, keep) {
  return names
    .filter((n) => NIGHTLY_PATTERN.test(n))
    .sort()
    .reverse()
    .slice(keep);
}
