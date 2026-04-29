import { NextResponse } from "next/server";
import { ensureUser, readJson, jsonError } from "@/lib/api";
import { plaidExchangeSchema } from "@/lib/validation";
import { getPlaidClient } from "@/lib/plaid-client";
import { encryptToken } from "@/lib/plaid-crypto";
import {
  createPlaidItem,
  upsertPlaidAccount,
  listPlaidAccountsByItem,
} from "@/lib/repos";

export async function POST(req: Request) {
  const auth = await ensureUser();
  if (auth instanceof NextResponse) return auth;

  const body = await readJson(req, plaidExchangeSchema);
  if (body instanceof NextResponse) return body;

  try {
    const plaid = getPlaidClient();

    // Exchange the short-lived public_token for a permanent access_token.
    const exchangeRes = await plaid.itemPublicTokenExchange({
      public_token: body.publicToken,
    });
    const accessToken = exchangeRes.data.access_token;

    // Encrypt before storing.
    const { enc, iv, tag } = encryptToken(accessToken);

    // Persist the item (no plaintext token in DB).
    const item = await createPlaidItem(auth.userId, {
      institutionId: body.institutionId,
      institutionName: body.institutionName,
      accessTokenEnc: enc,
      accessTokenIv: iv,
      accessTokenTag: tag,
      cursor: null,
      lastSyncedAt: null,
      isActive: true,
    });

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
        updatedAt: Date.now(),
      });
    }

    const accounts = await listPlaidAccountsByItem(item.id);
    return NextResponse.json({ item, accounts }, { status: 201 });
  } catch (err) {
    return jsonError(`Token exchange failed: ${(err as Error).message}`);
  }
}
