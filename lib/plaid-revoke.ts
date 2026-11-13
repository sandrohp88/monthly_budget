import "server-only";
import { getPlaidClient } from "./plaid-client";
import { decryptToken } from "./plaid-crypto";
import { listPlaidItems } from "./repos";
import type { PlaidItemRow } from "./db/schema";

/**
 * Revoke one Item at Plaid (`itemRemove`), best effort. Returns true when
 * Plaid accepted the removal. Never throws and never logs token material.
 * Shared by the single-item DELETE route and the user-removal route.
 */
export async function revokePlaidItemAtPlaid(item: PlaidItemRow): Promise<boolean> {
  try {
    const plaid = getPlaidClient();
    const accessToken = decryptToken(
      item.accessTokenEnc,
      item.accessTokenIv,
      item.accessTokenTag,
    );
    await plaid.itemRemove({ access_token: accessToken });
    return true;
  } catch (e) {
    // Log only the item id and the error class: Plaid/axios errors can echo
    // the request body, which holds the access token.
    console.error(
      `plaid itemRemove failed for item ${item.id}: ${e instanceof Error ? e.name : "error"}`,
    );
    return false;
  }
}

/**
 * Revoke every ACTIVE Plaid Item of a user. Inactive items were already
 * revoked (best effort) when they were removed, so they are not retried.
 * Returns how many could not be revoked; callers must not block on it. When
 * Plaid is not configured the items count as not revoked (nothing is thrown).
 */
export async function revokeUserPlaidItems(userId: string): Promise<{ failed: number }> {
  const items = await listPlaidItems(userId); // active only
  let failed = 0;
  for (const item of items) {
    if (!(await revokePlaidItemAtPlaid(item))) failed++;
  }
  return { failed };
}
