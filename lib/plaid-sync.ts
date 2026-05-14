import "server-only";
import { CountryCode, Products } from "plaid";
import { getPlaidClient } from "./plaid-client";
import { decryptToken } from "./plaid-crypto";
import {
  archiveExpiredPromos,
  getSettings,
  listCreditCards,
  listPlaidItems,
  listPlaidAccountsByItem,
  listPlaidDrafts,
  upsertPlaidAccount,
  upsertPlaidDraft,
  getPlaidDraft,
  updatePlaidItemCursor,
  getCreditCardByPlaidAccountId,
  createPromo,
  listPromosForCard,
  updatePromo,
  updatePlaidDraftStatus,
  updateCardCycleDays,
  upsertCreditCardStatementByDate,
  findMatchingOpenStatement,
} from "./repos";
import { todayIso } from "./dates";
import { dueDateFromStatement } from "./credit-cards";
import { detectPromoPayoffDate, plaidTransactionPromoTexts } from "./plaid-promo-parser";
import { classifyDraftKind } from "./plaid-transaction-kind";
import {
  allocatePayPalPaymentsFifo,
  isPayPalCreditAccount,
  isPayPalCreditPayment,
  isPayPalWalletAccount,
  isPayPalWalletPurchase,
  toPayPalFinancingPurchase,
} from "./paypal-special-financing";
import { log } from "./log";

// Pure helpers live in plaid-helpers.ts so they don't drag in "server-only"
// when imported from tests. Re-exported here for callers that already import
// them from this module.
export { toCents, looksLikePaid } from "./plaid-helpers";
import { toCents, looksLikePaid } from "./plaid-helpers";

const PLAID_TRANSACTION_HISTORY_DAYS = 730;

export interface SyncResult {
  added: number;
  modified: number;
  removed: number;
  cardsUpdated: number;
  statementsCreated: number;
}

type PlaidTransactionWithOriginalDescription = {
  original_description?: string | null;
};

function originalDescriptionOf(txn: PlaidTransactionWithOriginalDescription): string | null {
  return txn.original_description ?? null;
}

async function autoCreatePromoFromTransaction(input: {
  userId: string;
  transactionId: string;
  accountId: string;
  date: string;
  description: string;
  originalDescription: string | null;
  merchantName: string | null;
  amountCents: number;
  kind?: "expense" | "card_payment";
  promoTexts?: string[];
}): Promise<void> {
  if (input.amountCents <= 0) return;
  // Card-payment drafts are intra-account transfers, never a financed purchase.
  // Generic offer text on a payment description (e.g. "0 APR if paid in full")
  // would otherwise create a phantom promo for the payment amount.
  if (input.kind === "card_payment") return;
  const payoffDate = detectPromoPayoffDate([
    ...(input.promoTexts ?? []),
    input.originalDescription,
    input.description,
    input.merchantName,
  ]);
  if (!payoffDate) return;

  const [card, draft] = await Promise.all([
    getCreditCardByPlaidAccountId(input.userId, input.accountId),
    getPlaidDraft(input.userId, input.transactionId),
  ]);
  if (!card || !draft || draft.linkedPromoId) return;

  const promo = await createPromo(input.userId, card.id, {
    description: input.merchantName ?? input.description,
    originalAmountCents: input.amountCents,
    remainingAmountCents: input.amountCents,
    startDate: input.date,
    endDate: payoffDate,
    monthlyPaymentCents: null,
    notes: input.originalDescription ?? null,
    isActive: true,
  });
  await updatePlaidDraftStatus(input.userId, input.transactionId, {
    status: "approved",
    linkedPromoId: promo.id,
  });
}

async function autoCreatePromosFromExistingDrafts(userId: string, itemId: string): Promise<void> {
  const accounts = await listPlaidAccountsByItem(itemId);
  const accountIds = new Set(accounts.map((account) => account.id));
  if (accountIds.size === 0) return;

  const drafts = await listPlaidDrafts(userId, "approved");
  for (const draft of drafts) {
    if (!accountIds.has(draft.accountId) || draft.linkedPromoId) continue;
    await autoCreatePromoFromTransaction({
      userId,
      transactionId: draft.id,
      accountId: draft.accountId,
      date: draft.date,
      description: draft.description,
      originalDescription: draft.originalDescription,
      merchantName: draft.merchantName,
      amountCents: draft.amountCents,
      kind: draft.kind,
    });
  }
}

async function reconcilePayPalSpecialFinancing(userId: string, itemId: string): Promise<void> {
  const accounts = await listPlaidAccountsByItem(itemId);
  const paypalCreditAccount = accounts.find(isPayPalCreditAccount);
  if (!paypalCreditAccount) return;

  const card = await getCreditCardByPlaidAccountId(userId, paypalCreditAccount.id);
  if (!card) return;

  const walletAccountIds = new Set(accounts.filter(isPayPalWalletAccount).map((account) => account.id));
  if (walletAccountIds.size === 0) return;

  const drafts = (await listPlaidDrafts(userId, "approved")).filter((draft) =>
    accounts.some((account) => account.id === draft.accountId),
  );
  const latestDraftDate = drafts.reduce(
    (latest, draft) => (draft.date > latest ? draft.date : latest),
    "",
  );

  const walletPurchases = drafts
    .filter((draft) => walletAccountIds.has(draft.accountId))
    .filter(isPayPalWalletPurchase)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const purchases = walletPurchases
    .map(toPayPalFinancingPurchase)
    .filter((purchase): purchase is NonNullable<typeof purchase> => purchase !== null)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  if (purchases.length === 0) return;

  const payments = drafts
    .filter((draft) => draft.accountId === paypalCreditAccount.id && isPayPalCreditPayment(draft))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const remainingByDraftId = allocatePayPalPaymentsFifo(
    walletPurchases.map((purchase) => ({
      id: purchase.id,
      date: purchase.date,
      originalAmountCents: purchase.amountCents,
    })),
    payments.map((payment) => ({
      date: payment.date,
      amountCents: payment.amountCents,
    })),
  );

  const existingPromos = await listPromosForCard(userId, card.id, true);
  const promoById = new Map(existingPromos.map((promo) => [promo.id, promo]));

  for (const purchase of purchases) {
    const remainingAmountCents = remainingByDraftId.get(purchase.id) ?? purchase.amountCents;
    const isStillPromotional = purchase.endDate >= latestDraftDate;
    if (purchase.linkedPromoId) {
      const promo = promoById.get(purchase.linkedPromoId);
      if (!promo) continue;
      // PayPal's live promo list is more authoritative than transaction FIFO:
      // it includes issuer-specific payoff dates and targeted payment
      // allocation that Plaid transactions do not expose. When a promo row has
      // been reconciled from that list (or manually locked), never rewrite it
      // from the heuristic.
      if (promo.authoritativeSource !== null) continue;
      // A paid-off PayPal promo should stay paid off. Transaction history alone
      // is not enough to resurrect it on the next sync.
      if (!promo.isActive && promo.remainingAmountCents <= 0) continue;
      await updatePromo(userId, promo.id, {
        originalAmountCents: purchase.amountCents,
        remainingAmountCents,
        startDate: purchase.date,
        endDate: purchase.endDate,
        isActive: remainingAmountCents > 0 && isStillPromotional,
      });
      continue;
    }

    if (remainingAmountCents <= 0 || !isStillPromotional) continue;

    const promo = await createPromo(userId, card.id, {
      description: purchase.merchantName ?? purchase.description,
      originalAmountCents: purchase.amountCents,
      remainingAmountCents,
      startDate: purchase.date,
      endDate: purchase.endDate,
      monthlyPaymentCents: null,
      notes: `Auto-created from PayPal special financing transaction ${purchase.id}`,
      isActive: true,
    });
    await updatePlaidDraftStatus(userId, purchase.id, {
      status: "approved",
      linkedPromoId: promo.id,
    });
  }
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
          options: {
            include_original_description: true,
          },
        });

        const data = response.data;
        cursor = data.next_cursor;
        hasMore = data.has_more;

        // Fetch account list for this item to map account IDs.
        const accounts = await listPlaidAccountsByItem(item.id);
        const accountIds = new Set(accounts.map((a) => a.id));
        const accountById = new Map(accounts.map((a) => [a.id, a] as const));
        const linkedCards = await listCreditCards(userId, true);
        const linkedCardAccountIds = new Set(
          linkedCards
            .map((c) => c.plaidAccountId)
            .filter((id): id is string => id !== null && id !== undefined),
        );

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

        // Added transactions -> approved ledger rows.
        for (const txn of data.added) {
          if (!accountIds.has(txn.account_id)) continue;
          // Skip pending transactions — we'll pick them up when they post.
          if (txn.pending) continue;
          const originalDescription = originalDescriptionOf(txn);
          const amountCents = toCents(txn.amount);
          const account = accountById.get(txn.account_id);
          const kind = classifyDraftKind({
            amountCents,
            accountType: account?.type ?? null,
            accountIsLinkedToCard: linkedCardAccountIds.has(txn.account_id),
            primaryCategory: txn.personal_finance_category?.primary ?? null,
            detailedCategory: txn.personal_finance_category?.detailed ?? null,
            description: txn.name,
          });

          await upsertPlaidDraft({
            id: txn.transaction_id,
            userId,
            accountId: txn.account_id,
            date: txn.date,
            description: txn.name,
            originalDescription,
            amountCents,
            plaidCategory: txn.personal_finance_category?.primary ?? null,
            merchantName: txn.merchant_name ?? null,
            pending: false,
            status: "approved",
            kind,
            linkedExpenseId: null,
            linkedPromoId: null,
          });
          await autoCreatePromoFromTransaction({
            userId,
            transactionId: txn.transaction_id,
            accountId: txn.account_id,
            date: txn.date,
            description: txn.name,
            originalDescription,
            merchantName: txn.merchant_name ?? null,
            amountCents,
            kind,
            promoTexts: plaidTransactionPromoTexts(txn),
          });

          // Auto-match LOAN_PAYMENTS on credit accounts to open card statements
          if (
            kind === "card_payment" &&
            (txn.personal_finance_category?.primary ?? "").toUpperCase() === "LOAN_PAYMENTS" &&
            amountCents > 0
          ) {
            const match = await findMatchingOpenStatement(userId, amountCents, txn.date);
            if (match) {
              log.info(
                `plaid-sync: auto-matched card_payment ${txn.transaction_id} ($${(amountCents / 100).toFixed(2)}) ` +
                `to statement ${match.id} on card ${match.cardId}`,
              );
            }
          }

          added++;
        }

        // Modified transactions -> upsert again while preserving actioned status.
        for (const txn of data.modified) {
          if (!accountIds.has(txn.account_id)) continue;
          const originalDescription = originalDescriptionOf(txn);
          const amountCents = toCents(txn.amount);
          const account = accountById.get(txn.account_id);
          const kind = classifyDraftKind({
            amountCents,
            accountType: account?.type ?? null,
            accountIsLinkedToCard: linkedCardAccountIds.has(txn.account_id),
            primaryCategory: txn.personal_finance_category?.primary ?? null,
            detailedCategory: txn.personal_finance_category?.detailed ?? null,
            description: txn.name,
          });
          await upsertPlaidDraft({
            id: txn.transaction_id,
            userId,
            accountId: txn.account_id,
            date: txn.date,
            description: txn.name,
            originalDescription,
            amountCents,
            plaidCategory: txn.personal_finance_category?.primary ?? null,
            merchantName: txn.merchant_name ?? null,
            pending: txn.pending,
            status: "approved",
            kind,
            linkedExpenseId: null,
            linkedPromoId: null,
          });
          await autoCreatePromoFromTransaction({
            userId,
            transactionId: txn.transaction_id,
            accountId: txn.account_id,
            date: txn.date,
            description: txn.name,
            originalDescription,
            merchantName: txn.merchant_name ?? null,
            amountCents,
            kind,
            promoTexts: plaidTransactionPromoTexts(txn),
          });
          modified++;
        }

        removed += data.removed.length;
      }

      // Persist the advanced cursor.
      await updatePlaidItemCursor(item.id, cursor ?? "", Date.now());
      await autoCreatePromosFromExistingDrafts(userId, item.id);
      await reconcilePayPalSpecialFinancing(userId, item.id);

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

  // Sweep expired promos once per sync. Reads the user's timezone from
  // settings so the cutoff matches what the projection page treats as "today".
  const settings = await getSettings(userId);
  const today = todayIso(settings?.timezone);
  const archived = await archiveExpiredPromos(userId, today);
  if (archived > 0) {
    log.info(`plaid-sync: archived ${archived} expired promo(s) for user ${userId}`);
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

  // OAuth-required institutions (Navy Federal, Chase, BofA, etc.) won't load
  // unless we pass a redirect_uri that's also registered in the Plaid dashboard.
  // APP_URL is set in production to the public hostname (e.g. https://budget.sherrera.dev).
  // In dev it can be left unset — non-OAuth sandbox banks work without it.
  const appUrl = process.env.APP_URL?.replace(/\/$/, "");
  const redirectUri = appUrl ? `${appUrl}/plaid/oauth-return` : undefined;

  const response = await plaid.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: "FINANCE_OS",
    products: [Products.Transactions],
    optional_products: [Products.Liabilities],
    transactions: { days_requested: PLAID_TRANSACTION_HISTORY_DAYS },
    country_codes: [CountryCode.Us],
    language: "en",
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
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
    const accounts = await listPlaidAccountsByItem(itemId);
    const liveBalanceByAccountId = new Map(accounts.map((account) => [account.id, account.balanceCents] as const));
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
        await updateCardCycleDays(card.id, stmtDay, dueDay, stmtDate ?? undefined);
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
        const stmtBalCents = toCents(liab.last_statement_balance);
        const minimumPaymentCents =
          liab.minimum_payment_amount != null ? toCents(liab.minimum_payment_amount) : null;
        const payAmtCents = lastPayAmt != null ? toCents(lastPayAmt) : null;

        const looksPaid = looksLikePaid({
          lastPaymentDate: lastPayDate,
          lastPaymentCents: payAmtCents,
          statementDate: stmtDate,
          statementBalanceCents: stmtBalCents,
          minimumPaymentCents,
        });

        const statementChanged = await upsertCreditCardStatementByDate(card.id, {
          statementDate: stmtDate,
          dueDate: resolvedDue,
          statementBalanceCents: stmtBalCents,
          minimumPaymentCents,
          paidAmountCents: looksPaid ? payAmtCents : null,
          paidDate: looksPaid ? lastPayDate : null,
          liveBalanceCents: liveBalanceByAccountId.get(plaidAccountId) ?? card.currentBalanceCents,
        });
        if (statementChanged) statementsCreated++;
      }
    }
  } catch (err) {
    // Bank doesn't support Liabilities, or temporary Plaid hiccup — non-fatal.
    log.warn(`plaid-liabilities: skipped item ${itemId}: ${(err as Error).message}`);
  }

  return { cardsUpdated, statementsCreated };
}
