import { NextResponse } from "next/server";
import { ensureUser, jsonError } from "@/lib/api";
import { categoryUsageCount, deleteCategory, listCategories } from "@/lib/repos";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const all = await listCategories(auth.userId);
  const target = all.find((c) => c.id === id);
  if (!target) return jsonError("not found", 404);

  // Refuse if any bills/extras still reference this category by name
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
