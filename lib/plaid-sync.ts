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
  getCreditCardByPlaidAccountId,
  updateCardCycleDays,
  upsertCreditCardStatementByDate,
} from "./repos";
import { dueDateFromStatement } from "./credit-cards";
import { log } from "./log";

// Pure helpers live in plaid-helpers.ts so they don't drag in "server-only"
// when imported from tests. Re-exported here for callers that already import
// them from this module.
export { toCents, looksLikePaid } from "./plaid-helpers";
import { toCents, looksLikePaid } from "./plaid-helpers";

export interface SyncResult {
  added: number;
  modified: number;
  removed: number;
  cardsUpdated: number;
  statementsCreated: number;
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
  let totalCardsUpdated = 0;
  let totalStatementsCreated = 0;

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

      // Refresh credit-card cycle data + most recent statement from Liabilities.
      const liab = await syncCreditCardLiabilitiesForItem(userId, item.id, accessToken);
      totalCardsUpdated += liab.cardsUpdated;
      totalStatementsCreated += liab.statementsCreated;
    } catch (err) {
      log.error(`plaid-sync: failed for item ${item.id}: ${(err as Error).message}`);
    }
  }

  return {
    added: totalAdded,
    modified: totalModified,
    removed: totalRemoved,
    cardsUpdated: totalCardsUpdated,
    statementsCreated: totalStatementsCreated,
  };
}

/**
 * Creates a Plaid link_token for the frontend Link widget.
 * The token is short-lived (30 min) and user-specific.
 *
 * Liabilities is in `optional_products` so banks that don't support it (most
 * non-credit-card-issuing depository institutions) still let the user link
 * deposit accounts. When a bank DOES support it, we get credit card cycle
 * dates and statement balances back from `liabilitiesGet`.
 */
export async function createLinkToken(userId: string): Promise<string> {
  const plaid = getPlaidClient();
  const response = await plaid.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: "FINANCE_OS",
    products: [Products.Transactions],
    optional_products: [Products.Liabilities],
    country_codes: [CountryCode.Us],
    language: "en",
  });
  return response.data.link_token;
}

/**
 * Pulls credit-card liabilities for one item (institution login) and updates
 * any locally-linked credit cards' cycle days + most recent statement.
 *
 * Robust to:
 * - Banks that don't support Liabilities (catches and logs, doesn't throw).
 * - Plaid accounts not yet linked to a manual card (silently skips).
 * - Idempotent re-runs (statement upsert is keyed by (cardId, statementDate)).
 *
 * Returns the count of cards touched so the UI can report sync progress.
 */
export async function syncCreditCardLiabilitiesForItem(
  userId: string,
  itemId: string,
  accessToken: string,
): Promise<{ cardsUpdated: number; statementsCreated: number }> {
  const plaid = getPlaidClient();
  let cardsUpdated = 0;
  let statementsCreated = 0;

  try {
    const res = await plaid.liabilitiesGet({ access_token: accessToken });
    const credit = res.data.liabilities.credit ?? [];

    for (const liab of credit) {
      const plaidAccountId = liab.account_id;
      if (!plaidAccountId) continue;

      const card = await getCreditCardByPlaidAccountId(userId, plaidAccountId);
      if (!card) continue; // not linked to a manual card yet

      // Cycle days — derive day-of-month from issue/due dates when present.
      const stmtDate = liab.last_statement_issue_date ?? null;
      const dueDate = liab.next_payment_due_date ?? null;
      const stmtDay = stmtDate ? Number(stmtDate.split("-")[2]) : null;
      const dueDay = dueDate ? Number(dueDate.split("-")[2]) : null;
      if (stmtDay && dueDay && stmtDay >= 1 && stmtDay <= 31 && dueDay >= 1 && dueDay <= 31) {
        await updateCardCycleDays(card.id, stmtDay, dueDay);
        cardsUpdated++;
      }

      // Latest statement — only if Plaid gave us both a date and a balance.
      if (stmtDate && liab.last_statement_balance != null) {
        // If Plaid omits next_payment_due_date, derive it from the card's dueDay
        // using the same heuristic we use for manual cards.
        const resolvedDue = dueDate ?? dueDateFromStatement(stmtDate, card.dueDay);

        // If the most recent payment paid off the most recent statement, mark it.
        const lastPayDate = liab.last_payment_date ?? null;
        const lastPayAmt = liab.last_payment_amount ?? null;
        const stmtBalCents = Math.round(liab.last_statement_balance * 100);
        const payAmtCents = lastPayAmt != null ? Math.round(lastPayAmt * 100) : null;

        const looksPaid = looksLikePaid({
          lastPaymentDate: lastPayDate,
          lastPaymentCents: payAmtCents,
          statementDate: stmtDate,
          statementBalanceCents: stmtBalCents,
        });

        await upsertCreditCardStatementByDate(card.id, {
          statementDate: stmtDate,
          dueDate: resolvedDue,
          statementBalanceCents: stmtBalCents,
          paidAmountCents: looksPaid ? payAmtCents : null,
          paidDate: looksPaid ? lastPayDate : null,
        });
        statementsCreated++;
      }
    }
  } catch (err) {
    // Bank doesn't support Liabilities, or temporary Plaid hiccup — non-fatal.
    log.warn(`plaid-liabilities: skipped item ${itemId}: ${(err as Error).message}`);
  }

  return { cardsUpdated, statementsCreated };
}
