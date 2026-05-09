import { NextResponse } from "next/server";
import { runMigrations } from "@/lib/db/client";
import { setupSchema } from "@/lib/validation";
import { createOwnerAndDefaults, OwnerAlreadyExistsError, userExists } from "@/lib/repos";
import { readJson } from "@/lib/api";
import { log } from "@/lib/log";
import { newRequestId } from "@/lib/security";

export async function POST(req: Request) {
  const requestId = newRequestId();
  try {
    runMigrations();
    if (await userExists()) {
      return NextResponse.json({ error: "owner already exists" }, { status: 409 });
    }
    const data = await readJson(req, setupSchema);
    if (data instanceof NextResponse) return data;

    const user = await createOwnerAndDefaults(data);
    return NextResponse.json({ ok: true, userId: user.id });
  } catch (e) {
    if (e instanceof OwnerAlreadyExistsError) {
      // Lost a setup race — generic 409 with no detail.
      return NextResponse.json({ error: "owner already exists" }, { status: 409 });
    }
    // Any other error is unexpected. Log details server-side; return a
    // generic message + correlation id to the client.
    log.error("setup_failed", { requestId, error: (e as Error).message });
    return NextResponse.json(
      { error: "setup failed", requestId },
      { status: 500 },
    );
  }
}
