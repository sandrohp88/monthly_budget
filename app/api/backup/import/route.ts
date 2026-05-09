import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import { importAll } from "@/lib/repos";
import { backupImportSchema } from "@/lib/validation";

export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const data = await readJson(req, backupImportSchema);
  if (data instanceof NextResponse) return data;

  try {
    await importAll(auth.userId, data);
    return NextResponse.json({ ok: true });
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
