import { NextResponse } from "next/server";
import { ensureUser } from "@/lib/api";
import { exportAll } from "@/lib/repos";

export async function GET() {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  const data = await exportAll(auth.userId);
  return new NextResponse(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="budget-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
}
