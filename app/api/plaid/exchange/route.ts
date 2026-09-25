import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import { plaidExchangeSchema } from "@/lib/validation";
import { getPlaidClient } from "@/lib/plaid-client";
import { encryptToken } from "@/lib/plaid-crypto";
import {
  createPlaidItem,
  upsertPlaidAccount,
  listPlaidAccountsByItem,
  getCreditCardByPlaidAccountId,
  createCreditCard,
  deactivatePlaidItem,
} from "@/lib/repos";
import { syncCreditCardLiabilitiesForItem, withUserSyncLock } from "@/lib/plaid-sync";
import { log } from "@/lib/log";

export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const body = await readJson(req, plaidExchangeSchema);
  if (body instanceof NextResponse) return body;

  // Set once the item exists at Plaid, so a later failure can undo it instead
  // of leaving an active item with no accounts (review 2026-09-24 C11).
  let accessToken: string | null = null;
  let itemId: string | null = null;
  try {
    const plaid = getPlaidClient();

    // Exchange the short-lived public_token for a permanent access_token.
    const exchangeRes = await plaid.itemPublicTokenExchange({
      public_token: body.publicToken,
    });
    accessToken = exchangeRes.data.access_token;

    // Encrypt before storing.
    const { enc, iv, tag } = encryptToken(accessToken);

    // Persist the item (no plaintext token in DB). plaidItemId is how
    // webhooks address this item later.
    const item = await createPlaidItem(auth.userId, {
      institutionId: body.institutionId,
      institutionName: body.institutionName,
      accessTokenEnc: enc,
      accessTokenIv: iv,
      accessTokenTag: tag,
      cursor: null,
      lastSyncedAt: null,
      isActive: true,
      plaidItemId: exchangeRes.data.item_id,
    });
    itemId = item.id;

    // Immediately fetch accounts so the user sees them right away.
    const accountsRes = await plaid.accountsGet({ access_token: accessToken });
    for (const acct of accountsRes.data.accounts) {
      const balance = acct.balances.current ?? null;
      await upsertPlaidAccount({
        id: acct.account_id,
        itemId: item.id,
        userId: auth.userId,
        name: acct.name,
        mask: acct.mask ?? null,
        type: acct.type,
        subtype: acct.subtype ?? null,
        balanceCents: balance !== null ? Math.round(balance * 100) : null,
        // Same payload as balanceCents — see the column doc in schema.ts.
        availableBalanceCents:
          acct.balances.available != null ? Math.round(acct.balances.available * 100) : null,
        // Credit line, so a freshly linked card has utilization immediately
        // rather than waiting for the first sync.
        limitCents: acct.balances.limit != null ? Math.round(acct.balances.limit * 100) : null,
        updatedAt: Date.now(),
      });
    }

    // Auto-create a credit_cards row for each credit-type account that isn't
    // already linked to one. Idempotent on re-link (the unique index on
    // plaid_account_id + the existence check both protect against dupes).
    // Cycle days here are placeholders — overwritten by the liabilities sync
    // call below (or the next /api/plaid/sync run if Plaid hiccups).
    for (const acct of accountsRes.data.accounts) {
      if (acct.type !== "credit") continue;
      const existing = await getCreditCardByPlaidAccountId(auth.userId, acct.account_id);
      if (existing) continue;
      const displayName = acct.mask ? `${acct.name} ****${acct.mask}` : acct.name;
      await createCreditCard(auth.userId, {
        name: displayName,
        statementDay: 1,
        dueDay: 21,
        autoPay: false,
        isActive: true,
        plaidAccountId: acct.account_id,
        currentBalanceCents:
          acct.balances.current != null ? Math.max(0, Math.round(acct.balances.current * 100)) : null,
      });
    }

    // Best-effort: pull liabilities so the auto-created cards have real cycle
    // days + most recent statement before the user sees the page. Non-fatal —
    // the next manual sync will catch up if the bank doesn't support it or
    // Plaid times out here.
    const token = accessToken;
    try {
      await withUserSyncLock(auth.userId, () =>
        syncCreditCardLiabilitiesForItem(auth.userId, item.id, token),
      );
    } catch (err) {
      log.warn(`exchange: liabilities pre-fetch skipped: ${(err as Error).message}`);
    }

    const accounts = await listPlaidAccountsByItem(item.id);
    return NextResponse.json({ item, accounts }, { status: 201 });
  } catch (err) {
    // Undo a half-linked item: revoke it at Plaid (so it isn't billed or left
    // live) and deactivate it here. Best-effort — the original error is what
    // the caller needs to see.
    if (accessToken) {
      await getPlaidClient()
        .itemRemove({ access_token: accessToken })
        .catch((e: Error) => log.warn(`exchange: cleanup itemRemove failed: ${e.message}`));
    }
    if (itemId) {
      await deactivatePlaidItem(auth.userId, itemId).catch((e: Error) =>
        log.warn(`exchange: cleanup deactivate failed: ${e.message}`),
      );
    }
    return jsonError(`Token exchange failed: ${(err as Error).message}`);
  }
}
