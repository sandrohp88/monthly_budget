import { NextResponse } from "next/server";
import { ensureUser, jsonError, readJson } from "@/lib/api";
import {
  getBill,
  getCreditCard,
  getPaycheck,
  listCreditCardPaymentOverridesForUser,
  getExtra,
  getPlaidDraft,
  listPlaidAccounts,
  listDraftAllocations,
  replaceDraftAllocations,
  applyIncomeAllocations,
  reopenPaychecksSettledByDraft,
} from "@/lib/repos";
import { draftAllocationsSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const draft = await getPlaidDraft(auth.userId, id);
  if (!draft) return jsonError("Not found", 404);

  return NextResponse.json({ allocations: await listDraftAllocations(auth.userId, id) });
}

/**
 * Replace how this transaction divides across the obligations it paid.
 * See `draft_allocations` in lib/db/schema.ts for the semantics — chiefly
 * that allocations are exhaustive for their draft.
 */
export async function PUT(req: Request, ctx: Ctx) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  const draft = await getPlaidDraft(auth.userId, id);
  if (!draft) return jsonError("Not found", 404);
  if (draft.status === "dismissed") {
    return jsonError("Deleted transactions cannot be split", 409);
  }

  const body = await readJson(req, draftAllocationsSchema);
  if (body instanceof NextResponse) return body;

  const splitsIncome = body.allocations.some((a) => a.targetKind === "paycheck");
  const splitsExpense = body.allocations.some((a) => a.targetKind !== "paycheck");
  if (splitsIncome && draft.amountCents >= 0) {
    return jsonError("A deposit can only be split across expected income", 400);
  }
  if (splitsExpense && draft.amountCents <= 0) {
    return jsonError("A deposit can only be split across expected income", 400);
  }

  // Splitting more than the transaction would claim money the bank did not
  // report. Under-allocating is fine — the remainder stays unattributed.
  const total = body.allocations.reduce((s, a) => s + a.amountCents, 0);
  if (total > Math.abs(draft.amountCents)) {
    return jsonError("The split is larger than the transaction", 400);
  }

  // Every target must exist and belong to this user — a dangling target would
  // silently swallow its portion, which reads exactly like a settled bill.
  const seen = new Set<string>();
  const accounts = splitsIncome || body.allocations.some((a) => a.targetKind === "card_payment")
    ? await listPlaidAccounts(auth.userId)
    : [];
  for (const a of body.allocations) {
    const key = `${a.targetKind}:${a.targetId}:${a.targetDate}`;
    if (seen.has(key)) return jsonError("The same target appears twice", 400);
    seen.add(key);

    if (a.targetKind === "bill") {
      if (!(await getBill(auth.userId, a.targetId))) return jsonError("Bill not found", 404);
    } else if (a.targetKind === "paycheck") {
      if (draft.pending || draft.status !== "approved") {
        return jsonError("Only a posted deposit can be split across income", 400);
      }
      if (
        !accounts.some(
          (account) =>
            account.id === draft.accountId &&
            account.type === "depository" &&
            account.useAsStartingBalance,
        )
      ) {
        return jsonError("Link a posted deposit from a starting-balance bank account", 400);
      }
      const paycheck = await getPaycheck(auth.userId, a.targetId);
      if (!paycheck || !paycheck.isActive || paycheck.payDate !== a.targetDate) {
        return jsonError("Expected income not found", 404);
      }
    } else if (a.targetKind === "card_payment") {
      if (draft.pending || draft.status !== "approved" || !accounts.some((account) =>
        account.id === draft.accountId && account.type === "depository" && account.useAsStartingBalance)) {
        return jsonError("Link a posted debit from a starting-balance bank account", 400);
      }
      if (!(await getCreditCard(auth.userId, a.targetId))) return jsonError("Card not found", 404);
      const plans = await listCreditCardPaymentOverridesForUser(auth.userId);
      if (
        !plans.some(
          (p) => p.cardId === a.targetId && p.dueDate === a.targetDate && p.amountCents > 0,
        )
      ) {
        return jsonError("Planned payment not found", 404);
      }
    } else {
      const extra = await getExtra(auth.userId, a.targetId);
      if (!extra) return jsonError("One-time expense not found", 404);
    }
  }

  const previous = await listDraftAllocations(auth.userId, id);
  const hadIncome = previous.some((allocation) => allocation.targetKind === "paycheck");
  const allocations = await replaceDraftAllocations(auth.userId, id, body.allocations);
  if (splitsIncome) {
    await applyIncomeAllocations(auth.userId, id);
  } else if (hadIncome) {
    // Clearing an income split returns those rows to expected. The next sync
    // may match the deposit automatically; this pass only releases it.
    await reopenPaychecksSettledByDraft(auth.userId, id);
  }
  return NextResponse.json({ allocations });
}
