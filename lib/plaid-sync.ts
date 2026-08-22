import "server-only";
import { CountryCode, Products } from "plaid";
import { getPlaidClient } from "./plaid-client";
import { decryptToken } from "./plaid-crypto";
import {
  getSettings,
  listCreditCards,
  listPlaidItems,
  listPlaidAccountsByItem,
  listPlaidDrafts,
  upsertPlaidAccount,
  seedCreditLimitFromPlaid,
  upsertPlaidDraft,
  getPlaidDraft,
  updatePlaidItemCursor,
  markItemBalanceRefreshed,
  markItemTransactionsRefreshed,
  getCreditCardByPlaidAccountId,
  createPromo,
  updatePlaidDraftStatus,
  updateCardCycleDays,
  updateCreditCard,
  upsertCreditCardStatementByDate,
  updateStatement,
  settleStatementWithDraft,
  getStatementSettledByDraft,
  updatePlaidDraft,
  deletePlaidDraft,
  listStatements,
  listPromosForCard,
  listConsumedPaycheckDraftIds,
  listStartingBalanceDraftsInRange,
  listUnreconciledPaychecksInRange,
  settlePaycheckWithDraft,
} from "./repos";
import type { PlaidTransactionDraftRow } from "./db/schema";
import { addDaysIso, DEFAULT_TIMEZONE, todayIso } from "./dates";
import {
  matchPaycheckDeposits,
  PAYCHECK_MATCH_WINDOW_DAYS,
} from "./paycheck-reconciliation";
import {
  dueDateFromStatement,
  interestSavingCashDueCents,
  isStatementOpen,
} from "./credit-cards";
import { detectPromoPayoffDate, plaidTransactionPromoTexts } from "./plaid-promo-parser";
import { classifyDraftKind, looksLikeCardPayment, looksLikeReversal } from "./plaid-transaction-kind";
import {
  isPayPalCreditAccount,
  isPayPalWalletAccount,
  isPayPalWalletPurchase,
  toPayPalFinancingPurchase,
} from "./paypal-special-financing";
import { log } from "./log";
import { inferLinkedCardCycle } from "./linked-card-cycle";

// Pure helpers live in plaid-helpers.ts so they don't drag in "server-only"
// when imported from tests. Re-exported here for callers that already import
// them from this module.
export { toCents, looksLikePaid } from "./plaid-helpers";
import { toCents, looksLikePaid, plaidErrorCode } from "./plaid-helpers";

const PLAID_TRANSACTION_HISTORY_DAYS = 730;

export interface SyncResult {
  added: number;
  modified: number;
  removed: number;
  cardsUpdated: number;
  statementsCreated: number;
  /** Open statements auto-marked paid from a matching LOAN_PAYMENTS draft. */
  statementsReconciled: number;
  /** Scheduled paychecks auto-marked received from a matching deposit draft. */
  paychecksReconciled: number;
  /**
   * Starting-balance accounts refreshed from a LIVE `/accounts/balance/get`
   * rather than Plaid's cache. Zero is normal — the call is throttled per item
   * and only fires for depository accounts the projection anchors on.
   */
  liveBalancesRefreshed: number;
  /**
   * Items for which Plaid was forced to re-pull transactions from the bank
   * (`/transactions/refresh`). Zero is normal — throttled per item and only
   * for items anchoring a projection.
   */
  transactionsRefreshed: number;
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
 * that statement paid (same contract as the statements PATCH route and the
 * Liabilities sync; promo balances are never mutated — §17a). Without this, a
 * statement the user has already paid keeps projecting as a pending
 * obligation on its due date.
 *
 * The payment posts on the CREDIT account, reducing the balance — a NEGATIVE
 * amount for most issuers, positive for PayPal — so we reconcile on the
 * MAGNITUDE. Only payments on a credit account linked to one of the user's
 * cards reconcile (the card's own side of the payment); the depository-side
 * transfer is the same money and is left alone. `findMatchingOpenStatement`
 * requires the magnitude to be within ~$1 of the statement balance, so a
 * partial payment on a revolving card does NOT clear the statement.
 *
 * A draft settles at most one statement, EVER — `settleStatementWithDraft`
 * owns that invariant (global consumption gate + already-accounted heuristic
 * + unpaid-only matching on full-balance OR interest-saving amounts), so this
 * function is just the Plaid-side guards: classification, reversal shape, and
 * the active linked card. Idempotent by construction — a re-synced or backfilled draft is
 * consumed and settles nothing further.
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

  // Only reconcile from the credit account linked to an ACTIVE card.
  // findMatchingOpenStatement only ever scans active cards, so an archived
  // (but still linked) card can never match here regardless — this check
  // just makes that explicit instead of relying on an emergent empty-array
  // result, and keeps this function's participation decision in sync with
  // reconcileExistingCardPaymentDrafts's own active-card gate.
  const linkedCard = await getCreditCardByPlaidAccountId(input.userId, input.accountId);
  if (!linkedCard || !linkedCard.isActive) return false;

  const settled = await settleStatementWithDraft(input.userId, {
    draftId: input.transactionId,
    cardId: linkedCard.id,
    paymentCents,
    date: input.date,
  });
  if (!settled) return false;

  log.info(
    `plaid-sync: reconciled card_payment ${input.transactionId} ` +
      `($${(paymentCents / 100).toFixed(2)}) → statement ${settled.id} on card ${settled.cardId} (marked paid)`,
  );
  return true;
}

/**
 * Catch-up pass over already-synced approved drafts on this item's linked
 * credit accounts. Payments synced before card-payment detection existed were
 * stored as `expense` and never reconciled; a fresh cursor sync won't revisit
 * them. This re-evaluates each stored draft (using its persisted primary
 * category + description) against the classifier's CURRENT verdict and
 * writes it in both directions — not just forward to card_payment, but back
 * to expense too, so a fixed/tightened rule (see plaid-transaction-kind.ts)
 * can correct a previously-mislabeled draft instead of the flip becoming a
 * one-way ratchet. Safe to run every sync — reconciliation is idempotent (a
 * settled statement won't re-match). Returns the number of statements newly
 * settled.
 *
 * Linked accounts are restricted to ACTIVE cards — this must agree with
 * `reconcileCardPaymentDraft`'s own active check, or an archived-but-linked
 * card's payment gets classified card_payment (removed from spend) yet can
 * never actually reconcile (findMatchingOpenStatement only scans active
 * cards), silently.
 *
 * `allApprovedDrafts` is this item's full approved-drafts list, fetched once
 * by the caller and shared with the other post-sync passes (promo seeding)
 * instead of each re-querying it.
 */
async function reconcileExistingCardPaymentDrafts(
  userId: string,
  itemId: string,
  allApprovedDrafts: readonly PlaidTransactionDraftRow[],
): Promise<number> {
  const accounts = await listPlaidAccountsByItem(itemId);
  const creditAccountIds = [...new Set(accounts.filter((a) => a.type === "credit").map((a) => a.id))];
  if (creditAccountIds.length === 0) return 0;

  const linkedCards = (
    await Promise.all(creditAccountIds.map((id) => getCreditCardByPlaidAccountId(userId, id)))
  ).filter((card): card is NonNullable<typeof card> => card != null && card.isActive);
  if (linkedCards.length === 0) return 0;
  const linkedAccountIds = new Set(
    linkedCards.map((card) => card.plaidAccountId).filter((id): id is string => id != null),
  );

  // One statement load per linked card, shared by the two derivations below.
  const statementsPerCard = await Promise.all(linkedCards.map((card) => listStatements(card.id)));

  // Steady-state short-circuit: once every linked card's statements are
  // settled, no draft could possibly reconcile. This only skips the
  // expensive per-draft reconcile attempt below — the kind correction pass
  // still runs so a fixed/tightened classifier rule keeps correcting
  // mislabeled drafts even with nothing left to settle.
  const anyOpenStatements = statementsPerCard.some((stmts) => stmts.some(isStatementOpen));

  // Drafts that have PROVABLY settled a statement are payments regardless of
  // what the current (possibly tightened) heuristic says about their stored
  // category/description — never flip them back to expense, or the same
  // dollars count as spend while the settled statement also represents them.
  const settledDraftIds = new Set(
    statementsPerCard.flat().map((s) => s.settledByDraftId).filter((id): id is string => id != null),
  );

  // Pending transactions haven't posted yet — they're picked up once they
  // clear (same guard the modified-transactions path uses inline).
  const drafts = allApprovedDrafts.filter((d) => linkedAccountIds.has(d.accountId) && !d.pending);

  let reconciled = 0;
  for (const draft of drafts) {
    // User-actioned drafts (turned into a real one-time expense or promo)
    // already represent this money elsewhere — flipping kind out from under
    // them would double-represent it.
    if (draft.linkedExpenseId || draft.linkedPromoId) continue;

    // Stored drafts keep only the PRIMARY category — looksLikeCardPayment
    // works off that + the description.
    const verdict: "expense" | "card_payment" =
      settledDraftIds.has(draft.id) ||
      looksLikeCardPayment({
        primaryCategory: draft.plaidCategory,
        description: draft.description,
        amountCents: draft.amountCents,
      })
        ? "card_payment"
        : "expense";
    if (draft.kind !== verdict) {
      await updatePlaidDraft(userId, draft.id, { kind: verdict });
    }
    if (verdict !== "card_payment" || !anyOpenStatements) continue;

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

async function autoCreatePromosFromExistingDrafts(
  userId: string,
  itemId: string,
  allApprovedDrafts: readonly PlaidTransactionDraftRow[],
): Promise<void> {
  const accounts = await listPlaidAccountsByItem(itemId);
  const accountIds = new Set(accounts.map((account) => account.id));
  if (accountIds.size === 0) return;

  for (const draft of allApprovedDrafts) {
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
 * reconcile flow (`authoritativeSource = paypal_promo_list`) or an explicit
 * manual reconciliation.
 */
async function seedPayPalSpecialFinancingPromos(
  userId: string,
  itemId: string,
  allApprovedDrafts: readonly PlaidTransactionDraftRow[],
): Promise<void> {
  const accounts = await listPlaidAccountsByItem(itemId);
  const paypalCreditAccount = accounts.find(isPayPalCreditAccount);
  if (!paypalCreditAccount) return;

  const card = await getCreditCardByPlaidAccountId(userId, paypalCreditAccount.id);
  if (!card) return;

  const walletAccountIds = new Set(accounts.filter(isPayPalWalletAccount).map((account) => account.id));
  if (walletAccountIds.size === 0) return;

  const drafts = allApprovedDrafts.filter((draft) => walletAccountIds.has(draft.accountId));
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
 * How far back a posted deposit can be from today and still settle a
 * paycheck. Mirrors the projection's bill-reconcile lookback so both sides
 * of the ledger see the same slice of transaction history.
 */
const PAYCHECK_RECONCILE_LOOKBACK_DAYS = 45;

/**
 * Match posted deposits on the starting-balance accounts against scheduled
 * paychecks and PERSIST the result (actualReceived + actualAmountCents) —
 * the income-side analog of reconcileCardPaymentDraft. Runs once per sync at
 * user level: deposits and paychecks aren't tied to a single Plaid item.
 *
 * All invariants live in settlePaycheckWithDraft (consume-once draft gate +
 * the not-received→received edge), so a re-sync is a no-op and a manually
 * reconciled paycheck is never overwritten. This function just assembles the
 * matcher's inputs: unreconciled paychecks near the lookback window and
 * approved unconsumed deposit drafts inside it.
 *
 * Returns the number of paychecks newly marked received.
 */
async function reconcilePaycheckDeposits(userId: string, today: string): Promise<number> {
  const windowStart = addDaysIso(today, -PAYCHECK_RECONCILE_LOOKBACK_DAYS);
  const [pendingPaychecks, consumed] = await Promise.all([
    // A deposit at either end of the draft window can settle a paycheck up
    // to the match window away — pad the paycheck range accordingly.
    listUnreconciledPaychecksInRange(
      userId,
      addDaysIso(windowStart, -PAYCHECK_MATCH_WINDOW_DAYS),
      addDaysIso(today, PAYCHECK_MATCH_WINDOW_DAYS),
    ),
    listConsumedPaycheckDraftIds(userId),
  ]);
  if (pendingPaychecks.length === 0) return 0;

  const drafts = (await listStartingBalanceDraftsInRange(userId, windowStart, today)).filter(
    (d) => !consumed.has(d.id),
  );
  if (drafts.length === 0) return 0;

  let settled = 0;
  for (const m of matchPaycheckDeposits(pendingPaychecks, drafts)) {
    const row = await settlePaycheckWithDraft(userId, {
      paycheckId: m.paycheckId,
      draftId: m.draftId,
      amountCents: m.depositAmountCents,
      date: m.depositDate,
    });
    if (!row) continue;
    settled++;
    log.info(
      `plaid-sync: reconciled deposit ${m.draftId} ` +
        `($${(m.depositAmountCents / 100).toFixed(2)} on ${m.depositDate}) ` +
        `→ paycheck ${row.id} scheduled ${row.payDate} (marked received)`,
    );
  }
  return settled;
}

/**
 * Pulls new/modified transactions from Plaid for the user's active items.
 * Upserts drafts and advances each item's cursor.
 * This is polling-only — no webhook required.
 */
/**
 * Retire the pending draft that a now-posted transaction replaces.
 *
 * Plaid does NOT reuse the transaction_id when a pending transaction posts: it
 * issues a new one and points back at the old row via `pending_transaction_id`.
 * Leave the predecessor in place and the same charge is counted twice — once as
 * held pending cash and once as posted. Measured 2026-08-11: 5 of 5 Citi and 2
 * of 6 Navy Federal posted rows carried this field, so this is the normal path,
 * not an edge case.
 *
 * Dismisses rather than hard-deletes, matching how `data.removed` is handled —
 * dismissed rows drop out of every total but stay auditable.
 */
async function supersedePendingPredecessor(
  userId: string,
  txn: { pending_transaction_id?: string | null },
): Promise<void> {
  const predecessorId = txn.pending_transaction_id;
  if (!predecessorId) return;
  await deletePlaidDraft(userId, predecessorId);
}

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
  let totalLiveBalances = 0;
  let totalTransactionRefreshes = 0;

  const plaid = getPlaidClient();

  for (const item of targets) {
    try {
      const accessToken = decryptToken(
        item.accessTokenEnc,
        item.accessTokenIv,
        item.accessTokenTag,
      );

      // Whether anything under this item feeds a projection's starting
      // balance. Gates both live refreshes — the paid balance pull below and
      // the on-demand transaction pull here.
      const anchorsProjection = (await listPlaidAccountsByItem(item.id)).some(
        (a) => a.useAsStartingBalance && a.type === "depository",
      );

      // BEFORE the cursor read: make Plaid go get this item's transactions from
      // the bank, so the sync below picks them up in the same pass. The ledger
      // has to be as fresh as the balance or §17b holds cash for payments that
      // have already posted — see refreshItemTransactions.
      const txnRefresh = await refreshItemTransactions(
        item.id,
        accessToken,
        anchorsProjection,
        item.transactionsRefreshedAt ?? null,
      );
      if (txnRefresh.refreshed) totalTransactionRefreshes++;

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
        // Active cards only — an archived card's payments must not be treated
        // as "linked" here, or classification and reconciliation disagree
        // (see reconcileExistingCardPaymentDrafts's doc comment).
        const linkedCards = await listCreditCards(userId, false);
        const linkedCardAccountIds = new Set(
          linkedCards
            .map((c) => c.plaidAccountId)
            .filter((id): id is string => id !== null && id !== undefined),
        );

        // Upsert balance updates for each account. NOTE: `data.accounts` is
        // whatever transactions/sync chose to return — it can be absent, and
        // its balances carry no `limit` for most issuers. Credit lines are
        // therefore refreshed separately via /accounts/get after this loop
        // (refreshAccountsFromPlaid), not from here.
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
            // Written here (not only in refreshAccountsFromPlaid) because
            // current and available must always come from the SAME payload —
            // their difference is the pending float, and a fresh current
            // against a stale available invents one out of nothing.
            availableBalanceCents:
              acct.balances.available != null ? toCents(acct.balances.available) : null,
            limitCents: acct.balances.limit != null ? toCents(acct.balances.limit) : null,
            updatedAt: Date.now(),
          });
        }

        // Added transactions -> approved ledger rows.
        for (const txn of data.added) {
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

          // A pending transaction is a CLAIM that money is moving, not evidence
          // that it moved. It holds cash (see getPendingDraftOutflow) but must
          // never drive anything that treats a transaction as settled —
          // settling a statement or seeding a promo off a charge that can still
          // change amount, or vanish outright, is the double-count §17b exists
          // to prevent. Those all re-run when it posts for real.
          if (!txn.pending) {
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
            // settled — marks that statement paid (promo balances untouched).
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
            } else if (kind === "card_payment") {
              // A new payment that settled nothing is worth one log line: the
              // $1 match tolerance deliberately leaves partial/adjusted payments
              // unmatched, and this is the only signal that it happened.
              log.info(
                `plaid-sync: card_payment ${txn.transaction_id} ` +
                  `($${(Math.abs(amountCents) / 100).toFixed(2)} on ${txn.date}) ` +
                  `did not match any open statement — leaving unreconciled`,
              );
            }
          }

          await supersedePendingPredecessor(userId, txn);

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
          // Same rule as the added loop: a still-pending row is a claim, not
          // evidence. A pending charge can arrive here repeatedly as its amount
          // firms up, and seeding a promo off one would bake in a figure the
          // issuer hasn't committed to.
          if (!txn.pending) {
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
          }
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
          await supersedePendingPredecessor(userId, txn);
          modified++;
        }

        // A removed transaction no longer exists in the user's real history —
        // dismiss its draft so it stops being replayed by the backfill (and
        // drops out of spend/credit totals). Approving it into a real expense
        // or promo already created a separate record, so this doesn't erase
        // anything the user actioned.
        for (const removedTxn of data.removed) {
          if (!removedTxn.transaction_id) continue;
          // If this draft had auto-settled a statement, the payment it
          // represented no longer exists — un-settle so the statement's cash
          // due re-enters the projection instead of silently vanishing. Promo
          // balances are never mutated by paid state (§17a) — log loudly so
          // the user can double-check issuer reconciliation anyway.
          const settledStmt = await getStatementSettledByDraft(userId, removedTxn.transaction_id);
          if (settledStmt && settledStmt.paidAmountCents != null) {
            await updateStatement(settledStmt.id, {
              paidAmountCents: null,
              paidDate: null,
              settledByDraftId: null,
            });
            log.warn(
              `plaid-sync: transaction ${removedTxn.transaction_id} was removed by Plaid but had ` +
                `settled statement ${settledStmt.id} — statement re-opened; if this card has active ` +
                `promos, their remaining balances may need manual reconciliation`,
            );
          }
          await deletePlaidDraft(userId, removedTxn.transaction_id);
        }
        removed += data.removed.length;
      }

      // Persist the advanced cursor.
      await updatePlaidItemCursor(item.id, cursor ?? "", Date.now());
      // Fetched once and shared by the two promo passes below.
      const approvedDrafts = await listPlaidDrafts(userId, "approved");
      await autoCreatePromosFromExistingDrafts(userId, item.id, approvedDrafts);
      await seedPayPalSpecialFinancingPromos(userId, item.id, approvedDrafts);
      // Catch up payments synced before card-payment detection existed.
      // Re-fetched AFTER the promo passes: they set linkedPromoId on drafts
      // they act on, and the reconcile pass's user-actioned guard must see
      // those writes — a stale array would let it flip the kind of (and
      // reconcile) a draft that was promo-linked seconds earlier.
      const draftsAfterPromoPasses = await listPlaidDrafts(userId, "approved");
      totalStatementsReconciled += await reconcileExistingCardPaymentDrafts(
        userId,
        item.id,
        draftsAfterPromoPasses,
      );

      totalAdded += added;
      totalModified += modified;
      totalRemoved += removed;

      // Authoritative account snapshot: balances AND credit lines. Runs
      // outside the pagination loop and independently of whether
      // transactions/sync returned any accounts at all.
      await refreshAccountsFromPlaid(userId, item.id, accessToken);

      // ...then overwrite the CACHED balance with a live one for the accounts
      // the projection actually anchors on. Strictly after the call above,
      // which would otherwise clobber it. See refreshLiveBalancesForItem.
      const live = await refreshLiveBalancesForItem(
        userId,
        item.id,
        accessToken,
        item.balanceRefreshedAt ?? null,
      );
      totalLiveBalances += live.accountsRefreshed;

      // Refresh credit-card cycle data + most recent statement from Liabilities.
      const liab = await syncCreditCardLiabilitiesForItem(userId, item.id, accessToken);
      totalCardsUpdated += liab.cardsUpdated;
      totalStatementsCreated += liab.statementsCreated;
    } catch (err) {
      log.error(`plaid-sync: failed for item ${item.id}: ${(err as Error).message}`);
    }
  }

  // Use the user's timezone for the reconciliation cutoff.
  const settings = await getSettings(userId);
  const today = todayIso(settings?.timezone ?? DEFAULT_TIMEZONE);

  // Income side: match freshly-synced deposits to scheduled paychecks.
  // Idempotent (consume-once + not-received→received edge), so it's safe to
  // run on every sync, including single-item ones.
  const paychecksReconciled = await reconcilePaycheckDeposits(userId, today);

  return {
    added: totalAdded,
    modified: totalModified,
    removed: totalRemoved,
    cardsUpdated: totalCardsUpdated,
    statementsCreated: totalStatementsCreated,
    statementsReconciled: totalStatementsReconciled,
    paychecksReconciled,
    liveBalancesRefreshed: totalLiveBalances,
    transactionsRefreshed: totalTransactionRefreshes,
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
  // Registers the receiver for SYNC_UPDATES_AVAILABLE etc. on items created
  // through this Link session. Existing items keep whatever webhook they were
  // created with until updated via /item/webhook/update (ops step, see PR).
  const webhookUrl = appUrl ? `${appUrl}/api/plaid/webhook` : undefined;

  const response = await plaid.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: "FINANCE_OS",
    products: [Products.Transactions],
    optional_products: [Products.Liabilities],
    transactions: { days_requested: PLAID_TRANSACTION_HISTORY_DAYS },
    country_codes: [CountryCode.Us],
    language: "en",
    ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    ...(webhookUrl ? { webhook: webhookUrl } : {}),
  });
  return response.data.link_token;
}

/**
 * Refresh one item's accounts from `/accounts/get` — balances AND credit
 * lines — and seed the credit line of any card linked to those accounts.
 *
 * Why this exists separately from the transactions/sync loop: that loop reads
 * `data.accounts`, which is whatever transactions/sync happened to return.
 * That payload can be absent entirely, and even when present its balances
 * carry no `limit` for most issuers — so credit lines shipped in migration
 * 0034 never populated from it. `/accounts/get` is the documented,
 * authoritative source for `balances.limit`.
 *
 * Non-fatal: an issuer that errors here must not fail the whole sync — the
 * transactions for that item have already been persisted by this point.
 */
export async function refreshAccountsFromPlaid(
  userId: string,
  itemId: string,
  accessToken: string,
): Promise<{ accountsUpdated: number; limitsSeeded: number }> {
  const plaid = getPlaidClient();
  let accountsUpdated = 0;
  let limitsSeeded = 0;

  try {
    const known = await listPlaidAccountsByItem(itemId);
    const knownIds = new Set(known.map((a) => a.id));
    const cards = await listCreditCards(userId, false);
    const cardByAccountId = new Map(
      cards
        .filter((c) => c.plaidAccountId != null)
        .map((c) => [c.plaidAccountId as string, c] as const),
    );

    const res = await plaid.accountsGet({ access_token: accessToken });
    for (const acct of res.data.accounts) {
      // Only accounts we already track — linking new ones stays an explicit
      // user action on /accounts (see "Why we DON'T auto-create a card").
      if (!knownIds.has(acct.account_id)) continue;
      const balance = acct.balances.current ?? null;
      const limitCents = acct.balances.limit != null ? toCents(acct.balances.limit) : null;
      await upsertPlaidAccount({
        id: acct.account_id,
        itemId,
        userId,
        name: acct.name,
        mask: acct.mask ?? null,
        type: acct.type,
        subtype: acct.subtype ?? null,
        balanceCents: balance !== null ? toCents(balance) : null,
        // Same payload as balanceCents — see the column doc in schema.ts.
        availableBalanceCents:
          acct.balances.available != null ? toCents(acct.balances.available) : null,
        limitCents,
        updatedAt: Date.now(),
      });
      accountsUpdated += 1;

      // Seed the linked card's credit line while it has none. Manual wins
      // forever after — seedCreditLimitFromPlaid only writes over NULL.
      const card = cardByAccountId.get(acct.account_id);
      if (limitCents != null && card && (await seedCreditLimitFromPlaid(card.id, limitCents))) {
        limitsSeeded += 1;
      }
    }
    if (limitsSeeded > 0) {
      log.info(`plaid-accounts: seeded ${limitsSeeded} credit limit(s) for item ${itemId}`);
    }
  } catch (err) {
    log.warn(`plaid-accounts: refresh skipped for item ${itemId}: ${(err as Error).message}`);
  }

  return { accountsUpdated, limitsSeeded };
}

/**
 * Minimum gap between on-demand transaction refreshes for one item. Plaid caps
 * `/transactions/refresh` at 2/min and 120/hour per item
 * (`TRANSACTIONS_REFRESH_LIMIT`) — far looser than the balance endpoint, but
 * each call makes Plaid go out to the bank, so this stays deliberately modest.
 */
export const TRANSACTIONS_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;

export type TransactionsRefreshResult = {
  refreshed: boolean;
  /** Why no call was made, or null when one was attempted. */
  skipped: "no-anchor" | "throttled" | null;
};

/**
 * Force Plaid to go pull this item's transactions from the bank NOW.
 *
 * Why this is necessary and not just nice: Plaid polls an institution only
 * **one to four times a day**, and `/transactions/sync` returns whatever it
 * last collected. That is the entire "Alliant is a day behind" report — the
 * ledger, not just the balance, runs on a cache.
 *
 * A stale ledger is not a cosmetic problem, because §17b settles bill
 * occurrences on EVIDENCE: an occurrence with no matching posted transaction
 * keeps its cash held. Once `refreshLiveBalancesForItem` made the balance live,
 * a payment that had already posted at the bank — and was therefore already out
 * of that balance — was still being held, because its transaction hadn't been
 * delivered yet. The same $180 came out twice.
 *
 * Measured 2026-08-11: a $180 HOA payment had posted at Alliant (live balance
 * $400.05) with no corresponding draft, so the projection held $180 against a
 * balance that had already lost it and showed ~$220. Before the live balance
 * landed, the stale figure still contained that $180 and the two errors
 * cancelled; making one side fresh is what exposed the other.
 *
 * So: balance freshness and ledger freshness have to move together. Same narrow
 * gating as the balance pull — items anchoring a projection, throttled, non
 * fatal — and it runs BEFORE the sync loop so the cursor read picks up whatever
 * lands. If the institution's extraction is slower than this call, nothing is
 * lost: Plaid fires SYNC_UPDATES_AVAILABLE and the webhook drives another sync.
 */
export async function refreshItemTransactions(
  itemId: string,
  accessToken: string,
  anchorsProjection: boolean,
  lastRefreshedAt: number | null,
  now: number = Date.now(),
): Promise<TransactionsRefreshResult> {
  // Only items whose accounts actually feed a starting balance. Everywhere
  // else a day-old ledger costs accuracy, not correctness — no held cash to
  // wrongly keep holding — and this call is neither free nor unlimited.
  if (!anchorsProjection) return { refreshed: false, skipped: "no-anchor" };
  if (lastRefreshedAt != null && now - lastRefreshedAt < TRANSACTIONS_REFRESH_MIN_INTERVAL_MS) {
    return { refreshed: false, skipped: "throttled" };
  }

  const plaid = getPlaidClient();
  let refreshed = false;
  try {
    await plaid.transactionsRefresh({ access_token: accessToken });
    refreshed = true;
    log.info(`plaid-txn-refresh: forced an extraction for item ${itemId}`);
  } catch (err) {
    const code = plaidErrorCode(err);
    if (code === "TRANSACTIONS_REFRESH_LIMIT") {
      log.warn(`plaid-txn-refresh: rate limited for item ${itemId} — syncing cached transactions`);
    } else {
      // Plenty of institutions and plans simply don't offer on-demand refresh
      // (PRODUCT_NOT_READY, PRODUCTS_NOT_SUPPORTED). Degrade to the cached
      // ledger rather than failing the sync.
      log.warn(
        `plaid-txn-refresh: skipped for item ${itemId}: ${code ?? (err as Error).message}`,
      );
    }
  }

  // Stamped on failure too — see markItemTransactionsRefreshed.
  await markItemTransactionsRefreshed(itemId, now);
  return { refreshed, skipped: null };
}

/**
 * Minimum gap between live balance pulls for one item. Plaid caps
 * `/accounts/balance/get` at 5/min and 30/hour PER ITEM (`BALANCE_LIMIT`), and
 * bills a flat fee per successful call — so this is a cost control as much as
 * a rate-limit one. Five minutes leaves a ceiling of 12 calls/hour/item, well
 * inside the cap, while still meaning any sync more than five minutes after
 * the last one gets a genuinely live number.
 */
export const BALANCE_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;

export type LiveBalanceRefreshResult = {
  accountsRefreshed: number;
  /** Why no call was made, or null when one was attempted. */
  skipped: "no-anchor" | "throttled" | null;
};

/**
 * Pull a LIVE balance for the accounts this item anchors the projection on.
 *
 * Why this exists on top of `refreshAccountsFromPlaid`: `/accounts/get` and the
 * `data.accounts` payload on `/transactions/sync` both return Plaid's CACHED
 * balance — whatever it last scraped from the institution. When that cache
 * lags, the number can be badly stale while our row looks perfectly fresh,
 * because we stamp `updatedAt` at write time. Measured on 2026-08-11: Alliant
 * Credit Union's cached balance read $667.79 against a live $400.05 on the one
 * account anchoring a user's whole projection — a $267 error in the overdraft
 * direction, on an account with no pending float to blame (Alliant reports
 * `available == current` and returns no pending transactions at all).
 *
 * `/accounts/balance/get` is the only Plaid endpoint that forces a real-time
 * pull from the bank. It is also PAID per call and rate-limited per item, so
 * this is deliberately narrow: only depository accounts flagged
 * `useAsStartingBalance` — the ones whose balance actually becomes the
 * projection's starting point — and never more often than
 * BALANCE_REFRESH_MIN_INTERVAL_MS.
 *
 * MUST run AFTER `refreshAccountsFromPlaid`: that writes the cached balance and
 * would otherwise clobber the live one we just paid for.
 *
 * Non-fatal, like the other post-transaction refreshes — a bank that errors
 * here leaves the cached balance in place rather than failing the sync.
 */
export async function refreshLiveBalancesForItem(
  userId: string,
  itemId: string,
  accessToken: string,
  lastRefreshedAt: number | null,
  now: number = Date.now(),
): Promise<LiveBalanceRefreshResult> {
  const known = await listPlaidAccountsByItem(itemId);
  // Only what the projection actually anchors on. A credit account's balance
  // is a debt figure, never a starting balance, so it never justifies the call.
  const anchors = known.filter((a) => a.useAsStartingBalance && a.type === "depository");
  if (anchors.length === 0) return { accountsRefreshed: 0, skipped: "no-anchor" };

  if (lastRefreshedAt != null && now - lastRefreshedAt < BALANCE_REFRESH_MIN_INTERVAL_MS) {
    return { accountsRefreshed: 0, skipped: "throttled" };
  }

  const plaid = getPlaidClient();
  const anchorIds = new Set(anchors.map((a) => a.id));
  let accountsRefreshed = 0;

  try {
    const res = await plaid.accountsBalanceGet({
      access_token: accessToken,
      // Scope the call to the anchors — we pay for it, and a balance we don't
      // use is a balance we shouldn't fetch.
      options: { account_ids: anchors.map((a) => a.id) },
    });
    for (const acct of res.data.accounts) {
      if (!anchorIds.has(acct.account_id)) continue;
      const balance = acct.balances.current ?? null;
      // A payload with no `current` tells us nothing; writing it would erase a
      // balance we already have. Leave the cached row alone.
      if (balance === null) {
        log.warn(
          `plaid-balance: ${acct.account_id} returned no current balance — keeping cached value`,
        );
        continue;
      }
      await upsertPlaidAccount({
        id: acct.account_id,
        itemId,
        userId,
        name: acct.name,
        mask: acct.mask ?? null,
        type: acct.type,
        subtype: acct.subtype ?? null,
        balanceCents: toCents(balance),
        // Same payload as balanceCents, which is the whole point — see the
        // column doc in schema.ts. This call makes that pairing STRONGER than
        // the cached path: both halves are now live as of the same instant.
        availableBalanceCents:
          acct.balances.available != null ? toCents(acct.balances.available) : null,
        limitCents: acct.balances.limit != null ? toCents(acct.balances.limit) : null,
        updatedAt: now,
      });
      accountsRefreshed += 1;
    }
    if (accountsRefreshed > 0) {
      log.info(`plaid-balance: refreshed ${accountsRefreshed} live balance(s) for item ${itemId}`);
    }
  } catch (err) {
    const code = plaidErrorCode(err);
    if (code === "BALANCE_LIMIT" || code === "ACCOUNTS_BALANCE_GET_LIMIT") {
      // Expected under bursty webhooks; the throttle stamp below backs us off.
      log.warn(`plaid-balance: rate limited (${code}) for item ${itemId} — using cached balance`);
    } else {
      log.warn(
        `plaid-balance: live refresh skipped for item ${itemId}: ${(err as Error).message}`,
      );
    }
  }

  // Stamped on failure too — see markItemBalanceRefreshed. A bank that is down
  // or rate-limiting us must not be retried on every single sync.
  await markItemBalanceRefreshed(itemId, now);

  return { accountsRefreshed, skipped: null };
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
        const resolvedDue = dueDate ?? dueDateFromStatement(stmtDate, card.dueDay, card.gracePeriodDays);

        // If the most recent payment paid off the most recent statement, mark it.
        const lastPayDate = liab.last_payment_date ?? null;
        const lastPayAmt = liab.last_payment_amount ?? null;
        const stmtBalCents = toCents(liab.last_statement_balance);
        const minimumPaymentCents =
          liab.minimum_payment_amount != null ? toCents(liab.minimum_payment_amount) : null;
        const payAmtCents = lastPayAmt != null ? toCents(lastPayAmt) : null;

        // A payment covering the Interest Saving Balance (statement balance
        // minus 0%-promo principal plus this cycle's plan payments) avoids
        // interest without paying off the promos early — treat it as paid.
        const activePromos = await listPromosForCard(userId, card.id);
        const looksPaid = looksLikePaid({
          lastPaymentDate: lastPayDate,
          lastPaymentCents: payAmtCents,
          statementDate: stmtDate,
          statementBalanceCents: stmtBalCents,
          minimumPaymentCents,
          interestSavingDueCents: interestSavingCashDueCents(
            {
              statementBalanceCents: stmtBalCents,
              minimumPaymentCents,
              dueDate: resolvedDue,
            },
            activePromos,
          ),
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
      }
    }
  } catch (err) {
    // Bank doesn't support Liabilities, or temporary Plaid hiccup — non-fatal.
    log.warn(`plaid-liabilities: skipped item ${itemId}: ${(err as Error).message}`);
  }

  // Balance tracking and transaction-derived cycle inference do not depend on
  // the Liabilities product. Keep linked cards useful even when an issuer only
  // exposes Accounts + Transactions through Plaid.
  cardsUpdated += await reconcileLinkedCardTrackingForItem(userId, itemId);

  return { cardsUpdated, statementsCreated };
}

async function reconcileLinkedCardTrackingForItem(
  userId: string,
  itemId: string,
): Promise<number> {
  const [accounts, cards, drafts] = await Promise.all([
    listPlaidAccountsByItem(itemId),
    listCreditCards(userId, false),
    listPlaidDrafts(userId, "all"),
  ]);
  const accountById = new Map(accounts.map((account) => [account.id, account] as const));
  const linkedCards = cards.filter(
    (card) => card.plaidAccountId != null && accountById.has(card.plaidAccountId),
  );
  let changed = 0;

  for (const card of linkedCards) {
    const account = accountById.get(card.plaidAccountId!)!;
    const statements = await listStatements(card.id);
    const paymentDates = drafts
      .filter(
        (draft) =>
          draft.accountId === card.plaidAccountId &&
          draft.status === "approved" &&
          !draft.pending &&
          draft.kind === "card_payment",
      )
      .map((draft) => draft.date);
    const inferred = inferLinkedCardCycle({
      statementDates: statements.map((statement) => statement.statementDate),
      paymentDates,
      gracePeriodDays: card.gracePeriodDays,
    });

    const currentBalanceCents =
      account.balanceCents == null ? card.currentBalanceCents : Math.max(0, account.balanceCents);
    const needsBalanceUpdate = currentBalanceCents !== card.currentBalanceCents;
    const needsCycleUpdate =
      inferred != null &&
      (card.statementCycleMode !== "interval_days" ||
        card.statementCycleAnchorDate !== inferred.anchorDate ||
        card.statementCycleIntervalDays !== inferred.intervalDays);
    if (!needsBalanceUpdate && !needsCycleUpdate) continue;

    await updateCreditCard(userId, card.id, {
      ...(needsBalanceUpdate ? { currentBalanceCents } : {}),
      ...(needsCycleUpdate
        ? {
            statementCycleMode: "interval_days",
            statementCycleAnchorDate: inferred!.anchorDate,
            statementCycleIntervalDays: inferred!.intervalDays,
          }
        : {}),
    });
    changed++;
    if (needsCycleUpdate) {
      log.info(
        `plaid-sync: inferred ${inferred!.intervalDays}-day cycle for linked card ${card.id} ` +
          `from ${inferred!.source}; anchor ${inferred!.anchorDate}`,
      );
    }
  }

  return changed;
}
