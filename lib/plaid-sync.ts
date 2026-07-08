import "server-only";
import { CountryCode, Products } from "plaid";
import { getPlaidClient } from "./plaid-client";
import { decryptToken } from "./plaid-crypto";
import {
  applyPromoChunksForPaidStatement,
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
  updatePlaidDraftStatus,
  updateCardCycleDays,
  upsertCreditCardStatementByDate,
  updateStatement,
  findMatchingOpenStatement,
  getStatementSettledByDraft,
  setPlaidDraftKind,
  deletePlaidDraft,
} from "./repos";
import { todayIso } from "./dates";
import { dueDateFromStatement } from "./credit-cards";
import { detectPromoPayoffDate, plaidTransactionPromoTexts } from "./plaid-promo-parser";
import { classifyDraftKind, looksLikeCardPayment, looksLikeReversal } from "./plaid-transaction-kind";
import {
  isPayPalCreditAccount,
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
  /** Open statements auto-marked paid from a matching LOAN_PAYMENTS draft. */
  statementsReconciled: number;
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

/**
 * Reconcile a posted card payment against the open statement it settled: mark
 * that statement paid and fire the unpaid→paid promo decrement edge (same
 * contract as the statements PATCH route and the Liabilities sync). Without
 * this, a statement the user has already paid keeps projecting as a pending
 * cash debit on its due date.
 *
 * The payment posts on the CREDIT account, reducing the balance — a NEGATIVE
 * amount for most issuers, positive for PayPal — so we reconcile on the
 * MAGNITUDE. Only payments on a credit account linked to one of the user's
 * cards reconcile (the card's own side of the payment); the depository-side
 * transfer is the same money and is left alone. `findMatchingOpenStatement`
 * requires the magnitude to be within ~$1 of the statement balance, so a
 * partial payment on a revolving card does NOT clear the statement.
 *
 * A draft settles at most one statement, EVER — `getStatementSettledByDraft`
 * gates on that before matching, so a payment already consumed by one cycle
 * can't later "settle" another (a new statement appearing on a later sync
 * that happens to fall in the same amount/date window, or this same sync's
 * post-loop backfill re-scanning the draft it just reconciled inline).
 *
 * Idempotent: `findMatchingOpenStatement` only returns statements with no
 * recorded payment, so a re-synced (or backfilled) draft finds nothing to
 * settle and the promo decrement never double-fires.
 *
 * Returns true when it settled a statement.
 */
async function reconcileCardPaymentDraft(input: {
  userId: string;
  transactionId: string;
  accountId: string;
  amountCents: number;
  date: string;
  kind: "expense" | "card_payment";
  description?: string | null;
  originalDescription?: string | null;
}): Promise<boolean> {
  if (input.kind !== "card_payment") return false;
  const paymentCents = Math.abs(input.amountCents);
  if (paymentCents <= 0) return false;
  // A reversal/return of a prior payment must never settle a statement — it's
  // the same payment-like shape but money moving the other way.
  if (looksLikeReversal(input.description, input.originalDescription)) return false;

  // Only reconcile from the credit account linked to a card.
  const linkedCard = await getCreditCardByPlaidAccountId(input.userId, input.accountId);
  if (!linkedCard) return false;

  const alreadySettled = await getStatementSettledByDraft(linkedCard.id, input.transactionId);
  if (alreadySettled) return false;

  const match = await findMatchingOpenStatement(input.userId, paymentCents, input.date, {
    cardId: linkedCard.id,
  });
  if (!match) return false;

  await updateStatement(match.id, {
    paidAmountCents: paymentCents,
    paidDate: input.date,
    settledByDraftId: input.transactionId,
  });
  // findMatchingOpenStatement only returns unpaid statements, so this is always
  // the unpaid→paid edge — decrement promos exactly once.
  await applyPromoChunksForPaidStatement(input.userId, match.cardId, match.statementDate);
  log.info(
    `plaid-sync: reconciled card_payment ${input.transactionId} ` +
      `($${(paymentCents / 100).toFixed(2)}) → statement ${match.id} on card ${match.cardId} (marked paid)`,
  );
  return true;
}

/**
 * Catch-up pass over already-synced approved drafts on this item's linked
 * credit accounts. Payments synced before card-payment detection existed were
 * stored as `expense` and never reconciled; a fresh cursor sync won't revisit
 * them. This re-evaluates each stored draft (using its persisted primary
 * category + description), fixes a mislabeled `kind`, and reconciles it. Safe
 * to run every sync — reconciliation is idempotent (a settled statement won't
 * re-match). Returns the number of statements newly settled.
 */
async function reconcileExistingCardPaymentDrafts(userId: string, itemId: string): Promise<number> {
  const accounts = await listPlaidAccountsByItem(itemId);
  const creditAccountIds = new Set(accounts.filter((a) => a.type === "credit").map((a) => a.id));
  if (creditAccountIds.size === 0) return 0;

  const linkedAccountIds = new Set<string>();
  for (const id of creditAccountIds) {
    const card = await getCreditCardByPlaidAccountId(userId, id);
    if (card) linkedAccountIds.add(id);
  }
  if (linkedAccountIds.size === 0) return 0;

  // Pending transactions haven't posted yet — they're picked up once they
  // clear (same guard the modified-transactions path uses inline).
  const drafts = (await listPlaidDrafts(userId, "approved")).filter(
    (d) => linkedAccountIds.has(d.accountId) && !d.pending,
  );

  let reconciled = 0;
  for (const draft of drafts) {
    // Stored drafts keep only the PRIMARY category — looksLikeCardPayment works
    // off that + the description.
    if (!looksLikeCardPayment({ primaryCategory: draft.plaidCategory, description: draft.description })) {
      continue;
    }
    if (draft.kind !== "card_payment") {
      await setPlaidDraftKind(userId, draft.id, "card_payment");
    }
    const settled = await reconcileCardPaymentDraft({
      userId,
      transactionId: draft.id,
      accountId: draft.accountId,
      amountCents: draft.amountCents,
      date: draft.date,
      kind: "card_payment",
      description: draft.description,
      originalDescription: draft.originalDescription,
    });
    if (settled) reconciled++;
  }
  return reconciled;
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

/**
 * Seed promo rows for new PayPal special-financing purchases (wallet-account
 * purchases above the account's financing minimum). SEED-ONLY by design:
 * existing promo rows are NEVER rewritten from transaction history. Plaid
 * payment rows don't expose PayPal's targeted promo allocation, so any
 * amount reconciliation from transactions (the old FIFO heuristic) was
 * systematically wrong — every promo-drift incident traced back to it.
 * Amount/date corrections come from the paste-the-PayPal-promo-list
 * reconcile flow (`authoritativeSource = paypal_promo_list`) or the
 * unpaid→paid statement decrement edge.
 */
async function seedPayPalSpecialFinancingPromos(userId: string, itemId: string): Promise<void> {
  const accounts = await listPlaidAccountsByItem(itemId);
  const paypalCreditAccount = accounts.find(isPayPalCreditAccount);
  if (!paypalCreditAccount) return;

  const card = await getCreditCardByPlaidAccountId(userId, paypalCreditAccount.id);
  if (!card) return;

  const walletAccountIds = new Set(accounts.filter(isPayPalWalletAccount).map((account) => account.id));
  if (walletAccountIds.size === 0) return;

  const drafts = (await listPlaidDrafts(userId, "approved")).filter((draft) =>
    walletAccountIds.has(draft.accountId),
  );
  const latestDraftDate = drafts.reduce(
    (latest, draft) => (draft.date > latest ? draft.date : latest),
    "",
  );

  const purchases = drafts
    .filter(isPayPalWalletPurchase)
    .map(toPayPalFinancingPurchase)
    .filter((purchase): purchase is NonNullable<typeof purchase> => purchase !== null)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  for (const purchase of purchases) {
    if (purchase.linkedPromoId) continue; // already seeded — never rewrite
    if (purchase.endDate < latestDraftDate) continue; // promo window already over

    const promo = await createPromo(userId, card.id, {
      description: purchase.merchantName ?? purchase.description,
      originalAmountCents: purchase.amountCents,
      remainingAmountCents: purchase.amountCents,
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
  let totalStatementsReconciled = 0;

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

          // Auto-reconcile a posted card payment against the open statement it
          // settled — marks that statement paid + decrements promos.
          if (
            await reconcileCardPaymentDraft({
              userId,
              transactionId: txn.transaction_id,
              accountId: txn.account_id,
              amountCents,
              date: txn.date,
              kind,
              description: txn.name,
              originalDescription,
            })
          ) {
            totalStatementsReconciled++;
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
          // A payment that first posted as pending can arrive here (modified)
          // once it clears; reconcile it too. Idempotent — a settled statement
          // won't re-match.
          if (
            !txn.pending &&
            (await reconcileCardPaymentDraft({
              userId,
              transactionId: txn.transaction_id,
              accountId: txn.account_id,
              amountCents,
              date: txn.date,
              kind,
              description: txn.name,
              originalDescription,
            }))
          ) {
            totalStatementsReconciled++;
          }
          modified++;
        }

        // A removed transaction no longer exists in the user's real history —
        // dismiss its draft so it stops being replayed by the backfill (and
        // drops out of spend/credit totals). Approving it into a real expense
        // or promo already created a separate record, so this doesn't erase
        // anything the user actioned.
        for (const removedTxn of data.removed) {
          if (removedTxn.transaction_id) {
            await deletePlaidDraft(userId, removedTxn.transaction_id);
          }
        }
        removed += data.removed.length;
      }

      // Persist the advanced cursor.
      await updatePlaidItemCursor(item.id, cursor ?? "", Date.now());
      await autoCreatePromosFromExistingDrafts(userId, item.id);
      await seedPayPalSpecialFinancingPromos(userId, item.id);
      // Catch up payments synced before card-payment detection existed.
      totalStatementsReconciled += await reconcileExistingCardPaymentDrafts(userId, item.id);

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
    statementsReconciled: totalStatementsReconciled,
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

        const upsertResult = await upsertCreditCardStatementByDate(card.id, {
          statementDate: stmtDate,
          dueDate: resolvedDue,
          statementBalanceCents: stmtBalCents,
          minimumPaymentCents,
          paidAmountCents: looksPaid ? payAmtCents : null,
          paidDate: looksPaid ? lastPayDate : null,
          liveBalanceCents: liveBalanceByAccountId.get(plaidAccountId) ?? card.currentBalanceCents,
        });
        if (upsertResult.changed) statementsCreated++;
        // Same unpaid→paid edge contract as the statements PATCH route
        // (§17a): a statement Plaid observed transitioning to paid carries
        // each active promo's chunk for that cycle.
        if (upsertResult.becamePaid) {
          await applyPromoChunksForPaidStatement(userId, card.id, stmtDate);
        }
      }
    }
  } catch (err) {
    // Bank doesn't support Liabilities, or temporary Plaid hiccup — non-fatal.
    log.warn(`plaid-liabilities: skipped item ${itemId}: ${(err as Error).message}`);
  }

  return { cardsUpdated, statementsCreated };
}
