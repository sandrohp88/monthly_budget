import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { createUserSchema } from "@/lib/validation";
import { createMember, getSettings, listUsers, findUserByEmail } from "@/lib/repos";
import { readJson, jsonError } from "@/lib/api";

export async function GET() {
  try {
    await requireAdmin();
    const all = await listUsers();
    return NextResponse.json(all);
  } catch (e) {
    const msg = (e as Error).message;
    return jsonError(msg, msg === "forbidden" ? 403 : 401);
  }
}

export async function POST(req: Request) {
  try {
    const adminId = await requireAdmin();
    const data = await readJson(req, createUserSchema);
    if (data instanceof NextResponse) return data;

    const existing = await findUserByEmail(data.email);
    if (existing) return jsonError("email already in use", 409);

    // Same household, same timezone as the admin adding them.
    const adminSettings = await getSettings(adminId);
    const user = await createMember(data, { timezone: adminSettings?.timezone });
    return NextResponse.json(user, { status: 201 });
  } catch (e) {
    const msg = (e as Error).message;
    return jsonError(msg, msg === "forbidden" ? 403 : 401);
  }
}
