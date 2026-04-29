import "server-only";
import { CountryCode, Products } from "plaid";
import { getPlaidClient } from "./plaid-client";
import { decryptToken } from "./plaid-crypto";
import {
  listPlaidItems,
  listPlaidAccountsByItem,
  upsertPlaidAccount,
  upsertPlaidDraft,
  updatePlaidItemCursor,
} from "./repos";
import { log } from "./log";

/** Plaid sends amounts as positive for debits and negative for credits.
 *  We store positive = expense, negative = refund — same sign convention.
 *  Plaid amounts are in dollars (floating point); we multiply by 100 and round.
 */
function toCents(plaidAmount: number): number {
  return Math.round(plaidAmount * 100);
}

export interface SyncResult {
  added: number;
  modified: number;
  removed: number;
}

/**
 * Pulls new/modified transactions from Plaid for the user's active items.
 * Upserts drafts and advances each item's cursor.
 * This is polling-only — no webhook required.
 */
export async function syncPlaidTransactions(
  userId: string,
  filterItemId?: string,
): Promise<SyncResult> {
  const items = await listPlaidItems(userId);
  const targets = filterItemId ? items.filter((i) => i.id === filterItemId) : items;

  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;

  const plaid = getPlaidClient();

  for (const item of targets) {
    try {
      const accessToken = decryptToken(
        item.accessTokenEnc,
        item.accessTokenIv,
        item.accessTokenTag,
      );

      let cursor = item.cursor ?? undefined;
      let hasMore = true;
      let added = 0;
      let modified = 0;
      let removed = 0;

      // Plaid's transactions/sync is cursor-based and paginated.
      while (hasMore) {
        const response = await plaid.transactionsSync({
          access_token: accessToken,
          cursor,
          count: 100,
        });

        const data = response.data;
        cursor = data.next_cursor;
        hasMore = data.has_more;

        // Fetch account list for this item to map account IDs.
        const accounts = await listPlaidAccountsByItem(item.id);
        const accountIds = new Set(accounts.map((a) => a.id));

        // Upsert balance updates for each account.
        for (const acct of data.accounts ?? []) {
          if (!accountIds.has(acct.account_id)) continue;
          const balance = acct.balances.current ?? null;
          await upsertPlaidAccount({
            id: acct.account_id,
            itemId: item.id,
            userId,
            name: acct.name,
            mask: acct.mask ?? null,
            type: acct.type,
            subtype: acct.subtype ?? null,
            balanceCents: balance !== null ? toCents(balance) : null,
            updatedAt: Date.now(),
          });
        }

        // Added transactions → pending_review drafts.
        for (const txn of data.added) {
          if (!accountIds.has(txn.account_id)) continue;
          // Skip pending transactions — we'll pick them up when they post.
          if (txn.pending) continue;

          await upsertPlaidDraft({
            id: txn.transaction_id,
            userId,
            accountId: txn.account_id,
            date: txn.date,
            description: txn.name,
            amountCents: toCents(txn.amount),
            plaidCategory: txn.personal_finance_category?.primary ?? null,
            merchantName: txn.merchant_name ?? null,
            pending: false,
            status: "pending_review",
            linkedExpenseId: null,
          });
          added++;
        }

        // Modified transactions — upsert again (will preserve status if already actioned).
        for (const txn of data.modified) {
          if (!accountIds.has(txn.account_id)) continue;
          await upsertPlaidDraft({
            id: txn.transaction_id,
            userId,
            accountId: txn.account_id,
            date: txn.date,
            description: txn.name,
            amountCents: toCents(txn.amount),
            plaidCategory: txn.personal_finance_category?.primary ?? null,
            merchantName: txn.merchant_name ?? null,
            pending: txn.pending,
            status: "pending_review",
            linkedExpenseId: null,
          });
          modified++;
        }

        removed += data.removed.length;
      }

      // Persist the advanced cursor.
      await updatePlaidItemCursor(item.id, cursor ?? "", Date.now());

      totalAdded += added;
      totalModified += modified;
      totalRemoved += removed;
    } catch (err) {
      log.error(`plaid-sync: failed for item ${item.id}: ${(err as Error).message}`);
    }
  }

  return { added: totalAdded, modified: totalModified, removed: totalRemoved };
}

/**
 * Creates a Plaid link_token for the frontend Link widget.
 * The token is short-lived (30 min) and user-specific.
 */
export async function createLinkToken(userId: string): Promise<string> {
  const plaid = getPlaidClient();
  const response = await plaid.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: "FINANCE_OS",
    products: [Products.Transactions],
    country_codes: [CountryCode.Us],
    language: "en",
  });
  return response.data.link_token;
}
