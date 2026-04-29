import { NextResponse } from "next/server";
import { ensureUser, jsonError } from "@/lib/api";
import { listPlaidItems, listPlaidAccountsByItem } from "@/lib/repos";

export async function GET() {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  try {
    const items = await listPlaidItems(auth.userId);
    const data = await Promise.all(
      items.map(async (item) => ({
        ...item,
        accounts: await listPlaidAccountsByItem(item.id),
      })),
    );
    return NextResponse.json({ items: data });
  } catch (err) {
    return jsonError(`Failed to list items: ${(err as Error).message}`);
  }
}
