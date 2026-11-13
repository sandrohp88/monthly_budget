import "server-only";
import { getPlaidClient } from "./plaid-client";
import { decryptToken } from "./plaid-crypto";
import { plaidErrorCode } from "./plaid-helpers";
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
    // Log only the item id, error class and Plaid error code: Plaid/axios
    // errors can echo the request body, which holds the access token.
    console.error(
      `plaid itemRemove failed for item ${item.id}: ${e instanceof Error ? e.name : "error"} ${plaidErrorCode(e) ?? "no-code"}`,
    );
    return false;
  }
}

/**
 * Revoke already-loaded Plaid Items (best effort) and return how many failed.
 * Used by user delete, which reads the ACTIVE items inside the delete
 * transaction (`deleteUser`) and calls this AFTER the commit. Inactive items
 * are not retried: Plaid answers an already-removed Item with an error, which
 * would inflate the failure count. A revoke that failed at unlink time
 * therefore leaves a billed Item that only the Plaid dashboard can remove.
 * When Plaid is not configured the items count as failed; nothing throws.
 */
export async function revokePlaidItems(items: PlaidItemRow[]): Promise<{ failed: number }> {
  let failed = 0;
  for (const item of items) {
    if (!(await revokePlaidItemAtPlaid(item))) failed++;
  }
  return { failed };
}
