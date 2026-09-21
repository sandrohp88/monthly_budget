import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { importAll, previewImport } from "@/lib/repos";
import { writePreImportSnapshot } from "@/lib/backup-snapshot";
import { backupImportSchema } from "@/lib/validation";

/**
 * Restore a JSON backup over the signed-in user's data.
 *
 * Two-step by design: without `?confirm=1` this is a dry run that validates
 * the payload and returns what would be replaced (`preview`). Only an explicit
 * confirmation writes — and it first saves a server-side snapshot of the
 * current data, so a mistaken restore can be undone by re-importing it.
 */
export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const data = await readJson(req, backupImportSchema);
  if (data instanceof NextResponse) return data;

  const confirmed = new URL(req.url).searchParams.get("confirm") === "1";

  try {
    const preview = await previewImport(auth.userId, data);
    if (!confirmed) return NextResponse.json({ ok: true, applied: false, preview });

    const snapshot = await writePreImportSnapshot(auth.userId);
    await importAll(auth.userId, data);
    return NextResponse.json({
      ok: true,
      applied: true,
      snapshot,
      warnings: preview.warnings,
    });
  } catch (e) {
    // `validateImportGraph` throws with stable, payload-shape messages
    // ("X references unknown cardId Y", "duplicate creditCard id Z").
    // Surface these as a 400 — they're caller-correctable; keep the rest
    // generic so we don't leak internals.
    const msg = (e as Error).message ?? "import failed";
    if (msg.includes("references unknown") || msg.startsWith("duplicate ")) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    return jsonError(`import failed: ${msg}`);
  }
}
