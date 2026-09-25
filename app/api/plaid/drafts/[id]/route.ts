import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import { plaidDraftActionSchema } from "@/lib/validation";
import {
  getBill,
  getPlaidDraft,
  updatePlaidDraft,
  deletePlaidDraft,
  approveDraftAsExpense,
  dismissPendingDraft,
  setPlaidDraftBillLink,
  setPlaidDraftBillMatchExcluded,
  createPromoForDraft,
  getCreditCardByPlaidAccountId,
  listPlaidAccounts,
  listCategories,
} from "@/lib/repos";
import { isPayPalCreditAccount, isPayPalWalletAccount } from "@/lib/paypal-special-financing";

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

  if (body.action === "update_transaction") {
    if (draft.status === "dismissed") {
      return jsonError("Deleted transactions cannot be edited", 409);
    }
    const updated = await updatePlaidDraft(auth.userId, id, {
      date: body.date ?? draft.date,
      description: body.description ?? draft.description,
      amountCents: body.amountCents ?? draft.amountCents,
      plaidCategory: body.category ?? draft.plaidCategory,
    });
    return NextResponse.json({ draft: updated });
  }

  if (body.action === "link_bill") {
    if (draft.status === "dismissed") {
      return jsonError("Deleted transactions cannot be linked to a bill", 409);
    }
    const billId = body.billId ?? null;
    if (billId !== null) {
      if (draft.amountCents <= 0) {
        return jsonError("Only debit transactions can pay a bill", 400);
      }
      const bill = await getBill(auth.userId, billId);
      if (!bill) return jsonError("Bill not found", 404);
    }
    const updated = await setPlaidDraftBillLink(auth.userId, id, billId);
    return NextResponse.json({ draft: updated });
  }

  if (body.action === "exclude_bill_match") {
    if (draft.status === "dismissed") {
      return jsonError("Deleted transactions cannot be excluded from matching", 409);
    }
    const updated = await setPlaidDraftBillMatchExcluded(auth.userId, id, body.excluded === true);
    return NextResponse.json({ draft: updated });
  }

  if (
    (body.action === "approve" || body.action === "dismiss") &&
    draft.status !== "pending_review"
  ) {
    return jsonError("Draft has already been actioned", 409);
  }

  if (body.action === "dismiss") {
    // Conditional on still awaiting review: a concurrent approve wins cleanly.
    if (!dismissPendingDraft(auth.userId, id)) {
      return jsonError("Draft has already been actioned", 409);
    }
    return NextResponse.json({ draft: await getPlaidDraft(auth.userId, id) });
  }

  if (body.action === "create_promo") {
    if (draft.status === "dismissed") {
      return jsonError("Deleted transactions cannot be converted into promos", 409);
    }
    if (draft.amountCents <= 0) {
      return jsonError("Only debit purchases can be converted into promos", 400);
    }

    let card = await getCreditCardByPlaidAccountId(auth.userId, draft.accountId);
    if (!card) {
      const accounts = await listPlaidAccounts(auth.userId);
      const draftAccount = accounts.find((account) => account.id === draft.accountId);
      const pairedCreditAccount =
        draftAccount && isPayPalWalletAccount(draftAccount)
          ? accounts.find(
              (account) =>
                account.itemId === draftAccount.itemId && isPayPalCreditAccount(account),
            )
          : undefined;
      if (pairedCreditAccount) {
        card = await getCreditCardByPlaidAccountId(auth.userId, pairedCreditAccount.id);
      }
    }
    if (!card) {
      return jsonError("Link this Plaid account to a credit card before creating a promo", 400);
    }
    if (body.cardId !== card.id) {
      return jsonError("Linked credit card changed; refresh and try again", 409);
    }
    if (draft.linkedPromoId) {
      return jsonError("Transaction is already linked to a promo", 409);
    }

    const originalAmountCents = body.originalAmountCents ?? Math.abs(draft.amountCents);
    const remainingAmountCents = body.remainingAmountCents ?? originalAmountCents;
    if (remainingAmountCents > originalAmountCents) {
      return jsonError("Remaining amount cannot exceed original amount", 400);
    }

    // The promo and the draft's link are one write: a double submit (or a
    // sync that seeded a promo meanwhile) gets 409, never a second promo.
    const promo = createPromoForDraft(auth.userId, card.id, id, {
      description: body.description ?? draft.merchantName ?? draft.description,
      originalAmountCents,
      remainingAmountCents,
      startDate: body.startDate ?? draft.date,
      endDate: body.endDate ?? draft.date,
      monthlyPaymentCents: body.monthlyPaymentCents ?? null,
      notes: body.notes ?? null,
      isActive: true,
    });
    if (!promo) return jsonError("Transaction is already linked to a promo", 409);

    return NextResponse.json({ draft: await getPlaidDraft(auth.userId, id), promo });
  }

  // action === "approve": create a one_time_expense and link it.
  const categories = await listCategories(auth.userId);
  const requestedCategory = body.category ?? draft.plaidCategory ?? "Other";
  // Fall back to "Other" if the user-supplied category doesn't exist.
  const categoryName =
    categories.find((c) => c.name === requestedCategory)?.name ?? "Other";

  // Expense + status change in one write, conditional on the draft still
  // awaiting review — a double submit creates one expense, not two.
  const expense = approveDraftAsExpense(auth.userId, id, {
    date: body.date ?? draft.date,
    description: body.description ?? draft.description,
    amountCents: body.amountCents ?? draft.amountCents,
    category: categoryName,
    notes: body.notes ?? null,
  });
  if (!expense) return jsonError("Draft has already been actioned", 409);

  return NextResponse.json({ draft: await getPlaidDraft(auth.userId, id), expense });
}

export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const draft = await getPlaidDraft(auth.userId, id);
  if (!draft) return jsonError("Not found", 404);

  const updated = await deletePlaidDraft(auth.userId, id);
  return NextResponse.json({ draft: updated });
}
