import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import { plaidLinkCardSchema } from "@/lib/validation";
import {
  listPlaidAccounts,
  getPlaidItem,
  createCreditCard,
  setCreditCardPlaidLink,
  getCreditCardByPlaidAccountId,
} from "@/lib/repos";
import { decryptToken } from "@/lib/plaid-crypto";
import { syncCreditCardLiabilitiesForItem } from "@/lib/plaid-sync";

/**
 * Map a Plaid credit-card account to a manual credit_cards row, then
 * immediately pull liabilities so the card has real cycle days + statement.
 *
 * Body shapes:
 *   { creditCardId: "card_xyz" }   → link existing card
 *   { creditCardId: null }         → unlink
 *   { createNew: { name: "..." } } → create + link
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const { id: plaidAccountId } = await params;

  const body = await readJson(req, plaidLinkCardSchema);
  if (body instanceof NextResponse) return body;

  const accounts = await listPlaidAccounts(auth.userId);
  const plaidAccount = accounts.find((a) => a.id === plaidAccountId);
  if (!plaidAccount) return jsonError("Plaid account not found", 404);
  if (plaidAccount.type !== "credit") {
    return jsonError("Only credit-type accounts can be linked to a card", 400);
  }

  // ── unlink path ───────────────────────────────────────────────────────────
  if (body.creditCardId === null) {
    const linked = await getCreditCardByPlaidAccountId(auth.userId, plaidAccountId);
    if (!linked) return NextResponse.json({ ok: true, card: null });
    const result = await setCreditCardPlaidLink(auth.userId, linked.id, null);
    if (!result.ok) return jsonError(result.error, 400);
    return NextResponse.json({ ok: true, card: result.card });
  }

  // ── link path (existing or new) ───────────────────────────────────────────
  let cardId: string;
  if (body.createNew) {
    // Placeholder cycle days — overwritten by liabilities sync below if Plaid
    // returns dates. Day 1 / day 21 are sane fallbacks if the bank doesn't
    // expose Liabilities at all.
    const card = await createCreditCard(auth.userId, {
      name: body.createNew.name,
      statementDay: 1,
      dueDay: 21,
      autoPay: false,
      isActive: true,
      plaidAccountId,
      currentBalanceCents:
        plaidAccount.balanceCents != null ? Math.max(0, plaidAccount.balanceCents) : null,
    });
    cardId = card.id;
  } else if (typeof body.creditCardId === "string") {
    cardId = body.creditCardId;
  } else {
    return jsonError("Invalid request body", 400);
  }

  const linkResult = await setCreditCardPlaidLink(auth.userId, cardId, plaidAccountId);
  if (!linkResult.ok) return jsonError(linkResult.error, 400);

  // Best-effort immediate liabilities pull so the card lights up with real
  // data right after linking. Non-fatal — next /api/plaid/sync will catch up.
  try {
    const item = await getPlaidItem(auth.userId, plaidAccount.itemId);
    if (item) {
      const accessToken = decryptToken(
        item.accessTokenEnc,
        item.accessTokenIv,
        item.accessTokenTag,
      );
      await syncCreditCardLiabilitiesForItem(auth.userId, item.id, accessToken);
    }
  } catch {
    // swallow — link itself succeeded
  }

  return NextResponse.json({ ok: true, card: linkResult.card });
}
