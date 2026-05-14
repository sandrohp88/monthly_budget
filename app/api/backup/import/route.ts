import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { detectDuplicateBills, importAll, listBills } from "@/lib/repos";
import { backupImportSchema } from "@/lib/validation";

export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const data = await readJson(req, backupImportSchema);
  if (data instanceof NextResponse) return data;

  try {
    // Check for duplicate bills before import (import replaces all data,
    // so this is informational — the user can decide whether to proceed)
    const existingBills = await listBills(auth.userId, true);
    const warnings = detectDuplicateBills(existingBills, data.bills);

    await importAll(auth.userId, data);
    return NextResponse.json({ ok: true, warnings });
  } catch (e) {
    // `importAll` throws with stable, payload-shape messages
    // ("X references unknown cardId Y", "duplicate creditCard id Z").
    // Surface these as a 400 — they're caller-correctable; keep the rest
    // generic so we don't leak internals.
    const msg = (e as Error).message ?? "import failed";
    if (
      msg.includes("references unknown") ||
      msg.startsWith("duplicate ")
    ) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    return jsonError("import failed");
  }
}
