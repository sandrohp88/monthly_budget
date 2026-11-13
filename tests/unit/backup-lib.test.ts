import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupFileName, selectNightlyToPrune } from "../../scripts/backup-lib.mjs";

describe("backupFileName", () => {
  it("matches backup.sh naming: budget-YYYYMMDD-HHMMSS.db", () => {
    expect(backupFileName(new Date(2026, 10, 10, 16, 24, 10))).toBe(
      "budget-20261110-162410.db",
    );
  });
});

describe("selectNightlyToPrune", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("selects only nightly files beyond the newest 14", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-lib-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, "adhoc"));
    const nightly: string[] = [];
    for (let i = 1; i <= 17; i++) {
      const name = `budget-202611${String(i).padStart(2, "0")}-030000.db`;
      nightly.push(name);
      fs.writeFileSync(path.join(dir, name), "x");
    }
    const others = [
      "budget-predeploy-20261101-010101.db",
      "budget-manual.db",
      "budget-20261101-030000..db",
      "budget-20261101-030000.db.bak",
      "notes.txt",
    ];
    for (const o of others) fs.writeFileSync(path.join(dir, o), "x");

    const names = fs.readdirSync(dir);
    const pruned = selectNightlyToPrune(names, 14);
    // oldest three nightly files by name (names sort chronologically)
    expect([...pruned].sort()).toEqual(nightly.slice(0, 3));
    for (const o of [...others, "adhoc"]) expect(pruned).not.toContain(o);
  });

  it("selects nothing at or below the limit", () => {
    expect(selectNightlyToPrune(["budget-20261101-030000.db"], 14)).toEqual([]);
  });
});
