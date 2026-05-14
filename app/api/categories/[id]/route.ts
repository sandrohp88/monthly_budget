import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import {
  categoryUsageCount,
  deleteCategory,
  findCategoryByName,
  listCategories,
  updateCategory,
} from "@/lib/repos";
import { categoryUpdateSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const data = await readJson(req, categoryUpdateSchema);
  if (data instanceof NextResponse) return data;

  const all = await listCategories(auth.userId);
  const target = all.find((c) => c.id === id);
  if (!target) return jsonError("not found", 404);

  if (data.name && data.name.trim() !== target.name) {
    const existing = await findCategoryByName(auth.userId, data.name.trim());
    if (existing) return jsonError("category name already exists", 409);
  }

  const updated = await updateCategory(auth.userId, id, data);
  return NextResponse.json({ category: updated });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const all = await listCategories(auth.userId);
  const target = all.find((c) => c.id === id);
  if (!target) return jsonError("not found", 404);

  const usage = await categoryUsageCount(auth.userId, target.name);
  if (usage > 0) {
    return jsonError(
      `cannot delete: ${usage} bill${usage === 1 ? "" : "s"}/expense${usage === 1 ? "" : "s"} still use "${target.name}"`,
      409,
    );
  }

  await deleteCategory(auth.userId, id);
  return NextResponse.json({ ok: true });
}
