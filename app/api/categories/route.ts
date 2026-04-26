import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import { createCategory, findCategoryByName, listCategories } from "@/lib/repos";
import { categoryCreateSchema } from "@/lib/validation";

export async function GET() {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ categories: await listCategories(auth.userId) });
}

export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const data = await readJson(req, categoryCreateSchema);
  if (data instanceof NextResponse) return data;

  const name = data.name.trim();
  const existing = await findCategoryByName(auth.userId, name);
  if (existing) return jsonError("category name already exists", 409);

  const category = await createCategory(auth.userId, {
    name,
    color: data.color,
    kind: data.kind ?? "expense",
  });
  return NextResponse.json({ category }, { status: 201 });
}
