import { NextResponse } from "next/server";
import { runMigrations } from "@/lib/db/client";
import { setupSchema } from "@/lib/validation";
import { createOwnerAndDefaults, userExists } from "@/lib/repos";
import { readJson, jsonError } from "@/lib/api";

export async function POST(req: Request) {
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
    return jsonError((e as Error).message ?? "setup failed");
  }
}
