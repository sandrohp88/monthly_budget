import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import { plaidDraftActionSchema } from "@/lib/validation";
import {
  getPlaidDraft,
  updatePlaidDraftStatus,
  createExtra,
  listCategories,
} from "@/lib/repos";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  const body = await readJson(req, plaidDraftActionSchema);
  if (body instanceof NextResponse) return body;

  const draft = await getPlaidDraft(auth.userId, id);
  if (!draft) return jsonError("Not found", 404);

  if (draft.status !== "pending_review") {
    return jsonError("Draft has already been actioned", 409);
  }

  if (body.action === "dismiss") {
    const updated = await updatePlaidDraftStatus(auth.userId, id, { status: "dismissed" });
    return NextResponse.json({ draft: updated });
  }

  // action === "approve": create a one_time_expense and link it.
  const categories = await listCategories(auth.userId);
  const requestedCategory = body.category ?? draft.plaidCategory ?? "Other";
  // Fall back to "Other" if the user-supplied category doesn't exist.
  const categoryName =
    categories.find((c) => c.name === requestedCategory)?.name ?? "Other";

  const expense = await createExtra(auth.userId, {
    date: body.date ?? draft.date,
    description: body.description ?? draft.description,
    amountCents: body.amountCents ?? draft.amountCents,
    category: categoryName,
    notes: body.notes ?? null,
  });

  const updated = await updatePlaidDraftStatus(auth.userId, id, {
    status: "approved",
    linkedExpenseId: expense.id,
  });

  return NextResponse.json({ draft: updated, expense });
}
