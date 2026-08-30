import "server-only";
import { cache } from "react";
import { addDaysIso, todayIso } from "./dates";
import {
  getSettings,
  listBillPaymentOverridesForUser,
  listBillPaymentStatesForUser,
  listBills,
  listDraftAllocationsForUser,
  listCreditCardPaymentOverridesForUser,
  listCreditCards,
  listExtras,
  listPaychecks,
  listBillLinkDescriptors,
  listPlaidAccounts,
  listAllPromoPayments,
  listPromos,
  listStartingBalanceDraftsInRange,
  listStatementsForUser,
  listVariableBills,
  getLinkedBalanceSnapshot,
  getPendingDraftOutflow,
} from "./repos";
import {
  computeProjection,
  resolveProjectionStartDate,
  type OneTimeExpense,
  type ProjectionInput,
  type ProjectionRow,
} from "./projection";
import { projectCardPayments } from "./card-payments";
import {
  billAliasList,
  findExternallyPaidOccurrences,
  findHeldOccurrences,
  matchAllocatedObligations,
  findUnpaidRecentOccurrences,
  matchPaidBillOccurrences,
  occurrenceKey,
  type BillPaymentMark,
  type DraftAllocation,
  type HeldBillOccurrence,
  type PaidExtra,
  type UnpaidRecentOccurrence,
} from "./bill-reconciliation";

export type PromoPaymentSummary = {
  id: string;
  cardId: string;
  description: string;
  remainingAmountCents: number;
  endDate: string;
  monthlyPaymentCents: number | null;
};

export type ProjectionBundle = {
  rows: ProjectionRow[];
  startDate: string;
  endDate: string;
  /** Today in the user's configured timezone — exposed so client filters
   *  can compute date windows without re-deriving the timezone. */
  today: string;
  startingBalanceCents: number;
  projectionMonths: number;
  currency: string;
  promoSummariesByCard: Record<string, PromoPaymentSummary[]>;
  /**
   * Per-card "promo records exceed the live card balance after subtracting
   * unpaid statements" amount in cents. Nonzero values mean our promo state
   * is drifting higher than the issuer actually has on file — typically
   * because the unpaid→paid edge that decrements promos didn't fire (e.g.
   * Plaid never reported a payment, or the statement was marked paid with
   * $0). The projection silently caps the subtraction so the open-cycle
   * estimate doesn't go negative; the UI should surface this so the user
   * knows to reconcile.
   */
  promoDriftByCard: Record<string, number>;
  /** Category names for variable bill charge groups, keyed by `cardId:dueDate`. */
  variableBillCategoriesByKey: Record<string, string[]>;
  /**
   * Posted Plaid drafts that settled a bill occurrence (linked mode only),
   * keyed by draft id. Lets the transactions page mark a row as "this paid
   * bill X" using the exact same matches the projection acted on.
   */
  billMatchesByDraftId: Record<
    string,
    { billId: string; billName: string; occurrenceDate: string }
  >;
  /**
   * Bill occurrences settled by posted drafts (linked mode only), keyed by
   * bill id, ascending by occurrence date. Only covers the reconcile lookback
   * window (~45 days), so this is "the current cycle's payment", not history.
   */
  paidOccurrencesByBill: Record<
    string,
    Array<{ occurrenceDate: string; paidDate: string; paidAmountCents: number }>
  >;
  /**
   * Recently-due bill occurrences with NO matched payment (linked mode only)
   * — the "was this actually paid?" alert feed. Empty in manual mode.
   * Occurrences the user has already answered for (sent / paid externally)
   * drop out.
   */
  unpaidRecentOccurrences: UnpaidRecentOccurrence[];
  /**
   * Money committed but not yet posted, still held out of the projected
   * balance (linked mode only). `bills` are occurrences nothing has confirmed
   * as posted; `unattributedCents` is the remainder of the bank's own pending
   * float that no bill explains. See the pending-float block in
   * _buildProjection for the invariant that keeps the two from double-counting.
   */
  pendingPosting: {
    bills: HeldBillOccurrence[];
    /**
     * Every occurrence the user has answered for, so the UI can offer to take
     * it back. Without this a mark is a one-way door: an answered occurrence
     * leaves the unpaid alert, which is the only place it was reachable.
     */
    answered: Array<{
      billId: string;
      billName: string;
      dueDate: string;
      state: "sent" | "paid_externally";
      amountCents: number;
    }>;
    /**
     * The bank's own pending float: max(bank's `current − available`, Σ Plaid's
     * pending transaction rows). Two views of the SAME pending set, so this is
     * a max and never a sum — see the pending-float block in _buildProjection.
     * 0 when the institution reports neither.
     */
    bankPendingOutflowCents: number;
    /** Σ of the held bill occurrences above. */
    attributedCents: number;
    /** max(0, bankPendingOutflow − attributed) — pending spend no bill explains. */
    unattributedCents: number;
    /** attributed + unattributed: total cash held back from the balance. */
    totalHeldCents: number;
  };
};

export const buildProjection = cache(_buildProjection);

async function _buildProjection(userId: string): Promise<ProjectionBundle | null> {
  const settings = await getSettings(userId);
  if (!settings) return null;

  const today = todayIso(settings.timezone);

  // End date = today + projectionMonths (approx, using 31 days per month for a safe upper bound).
  const endDate = addDaysIso(today, settings.projectionMonths * 31);

  const [
    bills,
    billPaymentOverrides,
    creditCardPaymentOverrides,
    paychecks,
    extras,
    statements,
    activeCards,
    balanceSnapshot,
    plaidAccts,
    promos,
    promoPayments,
    variableBills,
    billPaymentMarks,
    pendingDraftOutflowCents,
  ] =
    await Promise.all([
      listBills(userId, false),
      listBillPaymentOverridesForUser(userId),
      listCreditCardPaymentOverridesForUser(userId),
      listPaychecks(userId),
      listExtras(userId),
      listStatementsForUser(userId),
      listCreditCards(userId, false),
      getLinkedBalanceSnapshot(userId),
      listPlaidAccounts(userId),
      listPromos(userId, false),
      listAllPromoPayments(userId),
      listVariableBills(userId, false),
      listBillPaymentStatesForUser(userId),
      getPendingDraftOutflow(userId),
    ]);
  /**
   * The observed float: the bank's `current − available` and Plaid's pending
   * transaction rows are two measures of the SAME money, so take the larger and
   * never the sum. Either can be 0 while the other is right — Alliant and Navy
   * Federal both report `available == current` on checking (no bank float at
   * all), while an institution that reports no pending rows leaves only the
   * balance difference. Whichever sees more of the pending set wins.
   */
  const observedFloatCents = Math.max(
    balanceSnapshot?.pendingOutflowCents ?? 0,
    pendingDraftOutflowCents,
  );
  const linkedBalance = balanceSnapshot?.balanceCents ?? null;
  const activeCardIds = new Set(activeCards.map((c) => c.id));
  const billOverridesByBill = new Map<string, Array<{ date: string; amountCents: number }>>();
  for (const override of billPaymentOverrides) {
    const list = billOverridesByBill.get(override.billId) ?? [];
    list.push({ date: override.dueDate, amountCents: override.amountCents });
    billOverridesByBill.set(override.billId, list);
  }

  // Bills paid via an ACTIVE credit card don't move cash on their own — the
  // card's statement payment carries them. Skip them from the projection to
  // avoid double-counting. Bills linked to an archived card fall back to cash
  // so we never silently lose visibility of a recurring obligation.
  const cashBills = bills.filter(
    (b) => b.paidViaCardId == null || !activeCardIds.has(b.paidViaCardId),
  );
  // Card-charged bills still show up as zero-cash markers so the calendar can
  // say "this lands on card X today" without double-counting the cash (the
  // card's payment already carries it).
  const cardNameById = new Map(activeCards.map((c) => [c.id, c.name] as const));
  const cardChargedBills = bills.filter(
    (b) => b.paidViaCardId != null && activeCardIds.has(b.paidViaCardId),
  );

  // All credit-card cash-out (statements, open-cycle estimate, promo chunks,
  // variable spend, planned payments) is computed in one place. The
  // authoritative-statement rule and override coordination live inside.
  const cardPayments = projectCardPayments({
    today,
    endDate,
    activeCards,
    statements,
    promos,
    promoPayments,
    variableBills,
    plaidAccounts: plaidAccts,
    cardPaymentOverrides: creditCardPaymentOverrides,
  });

  // Opt-in: if the user has marked a linked account as their starting balance source,
  // substitute its live balance for the manual startingBalanceCents.
  const linked = linkedBalance != null;
  // The MAX_LOOKBACK_DAYS cap (including the linked-mode "schema default of
  // 1970-01-01 means no lookback at all" special case) lives inside
  // resolveProjectionStartDate now, shared by both linked and manual modes.
  const startDate = resolveProjectionStartDate({
    startingBalanceAsOf: settings.startingBalanceAsOf,
    today,
    usesLinkedStartingBalance: linked,
  });
  // Lookback: linked + the user has rolled startingBalanceAsOf to a past date
  // (within the cap) to see historical context — paid bills, recent expenses
  // — alongside the forward projection. Past balances are reconstructed from
  // posted Plaid drafts on the linked starting-balance accounts.
  const lookback = linked && startDate < today;

  const historicalDrafts = lookback
    ? await listStartingBalanceDraftsInRange(userId, startDate, today)
    : [];

  // Reconcile posted payments against generated bill occurrences so a bill
  // that was already paid this cycle (e.g. the utility payment visible in
  // transactions) shows as a PAID marker instead of a pending debit. Linked
  // mode only: the live balance already reflects the posted payment, so
  // projecting the occurrence again would double-count; in manual mode the
  // occurrence must keep debiting the running balance.
  const RECONCILE_LOOKBACK_DAYS = 45;
  const paidOccurrencesByBill = new Map<
    string,
    Array<{ date: string; paidAmountCents?: number }>
  >();
  const billMatchesByDraftId: ProjectionBundle["billMatchesByDraftId"] = {};
  const paidOccurrencesByBillOut: ProjectionBundle["paidOccurrencesByBill"] = {};
  let unpaidRecentOccurrences: UnpaidRecentOccurrence[] = [];
  // Cash committed but not yet posted — see the pending-float block below.
  let heldOccurrences: HeldBillOccurrence[] = [];
  const heldByBill = new Map<string, HeldBillOccurrence[]>();
  const externallyPaidByBill = new Map<string, Array<{ date: string; amountCents: number | null }>>();
  // One-time expenses settled by an explicit split, keyed by expense id.
  const paidExtraById = new Map<string, PaidExtra>();
  let unattributedPendingCents = 0;
  let answeredOccurrences: ProjectionBundle["pendingPosting"]["answered"] = [];
  if (linked) {
    const [rawDrafts, linkDescriptors, allocationRows] = await Promise.all([
      listStartingBalanceDraftsInRange(
        userId,
        addDaysIso(today, -RECONCILE_LOOKBACK_DAYS),
        today,
      ),
      listBillLinkDescriptors(userId),
      listDraftAllocationsForUser(userId),
    ]);
    // Attach each draft's explicit split (if any). Fetched separately rather
    // than joined so a draft with three allocations stays one draft.
    const allocationsByDraft = new Map<string, DraftAllocation[]>();
    for (const a of allocationRows) {
      const list = allocationsByDraft.get(a.draftId) ?? [];
      list.push({
        targetKind: a.targetKind,
        targetId: a.targetId,
        targetDate: a.targetDate,
        amountCents: a.amountCents,
      });
      allocationsByDraft.set(a.draftId, list);
    }
    const recentDrafts = rawDrafts.map((d) => ({
      ...d,
      allocations: allocationsByDraft.get(d.id),
    }));
    // Every descriptor the user ever manually linked to a bill becomes an
    // alias: banks repeat the same wording each month, so one link teaches
    // all future cycles. The bill's own match_alias column (user-entered
    // wording, comma-separated) feeds the same gate.
    const aliasesByBill = new Map<string, string[]>();
    for (const d of linkDescriptors) {
      const list = aliasesByBill.get(d.billId) ?? [];
      list.push(d.description);
      if (d.merchantName) list.push(d.merchantName);
      aliasesByBill.set(d.billId, list);
    }
    for (const b of cashBills) {
      const fromColumn = billAliasList(b.matchAlias);
      if (fromColumn.length === 0) continue;
      const list = aliasesByBill.get(b.id) ?? [];
      list.push(...fromColumn);
      aliasesByBill.set(b.id, list);
    }
    const reconcilableBills = cashBills.map((b) => ({
      id: b.id,
      name: b.name,
      amountCents: b.amountCents,
      intervalMonths: b.intervalMonths,
      anchorDate: b.anchorDate,
      overridesByDate: new Map(
        (billOverridesByBill.get(b.id) ?? []).map((o) => [o.date, o.amountCents] as const),
      ),
    }));
    // The user's own splits first — they are statements of fact, and a
    // heuristic must never overrule (or re-credit) money already assigned.
    // One-time expenses are only reconcilable through this path.
    const reconcilableExtras = extras
      .filter((e) => e.paidViaCardId == null || !activeCardIds.has(e.paidViaCardId))
      .map((e) => ({
        id: e.id,
        description: e.description,
        date: e.date,
        amountCents: e.amountCents,
      }));
    const allocated = matchAllocatedObligations(
      reconcilableBills,
      reconcilableExtras,
      recentDrafts,
    );
    for (const p of allocated.extras) paidExtraById.set(p.extraId, p);

    const matches = [
      ...allocated.bills,
      ...matchPaidBillOccurrences(reconcilableBills, recentDrafts, {
        aliasesByBill,
        excludeDraftIds: allocated.allocatedDraftIds,
        excludeOccurrenceKeys: allocated.allocatedOccurrenceKeys,
      }),
    ].sort(
      (a, b) => a.billId.localeCompare(b.billId) || a.occurrenceDate.localeCompare(b.occurrenceDate),
    );
    const billNameById = new Map(cashBills.map((b) => [b.id, b.name] as const));
    for (const m of matches) {
      const list = paidOccurrencesByBill.get(m.billId) ?? [];
      list.push({ date: m.occurrenceDate, paidAmountCents: m.paidAmountCents });
      paidOccurrencesByBill.set(m.billId, list);
      // matches arrive sorted by (billId, occurrenceDate), so these stay ascending
      const out = paidOccurrencesByBillOut[m.billId] ?? [];
      out.push({
        occurrenceDate: m.occurrenceDate,
        paidDate: m.paidDate,
        paidAmountCents: m.paidAmountCents,
      });
      paidOccurrencesByBillOut[m.billId] = out;
      for (const draftId of m.draftIds) {
        billMatchesByDraftId[draftId] = {
          billId: m.billId,
          billName: billNameById.get(m.billId) ?? "Bill",
          occurrenceDate: m.occurrenceDate,
        };
      }
    }
    // ── Money committed but not yet posted ──────────────────────────────
    // A due date passing is not evidence that a bill was paid. Plaid's live
    // balance is `balances.current`, which excludes pending debits, so an ACH
    // pull that has left the account but hasn't posted is invisible on both
    // sides: still inside the live balance, and (once its date passes) no
    // longer projected. That combination overstated the projected balance by
    // the full amount of every bill in flight.
    //
    // Two independent sources of truth close it, and neither one assumes:
    //   - the BANK's own pending float (`current − available`), which is
    //     exactly "money that has left but hasn't posted";
    //   - the USER's per-occurrence marks (sent / paid externally).
    //
    // They overlap: a bill the user marked sent is usually the same money the
    // bank is reporting as pending. Holding both would double-count it, so
    // the marks ATTRIBUTE the float rather than adding to it:
    //
    //     totalHeld = max(bankPendingOutflow, attributed)
    //
    // Attributed cash rides its own bill occurrence (so the user can see what
    // it is); only the unexplained remainder becomes an anonymous hold. When
    // the bank reports no available balance the float is 0 and this degrades
    // to purely the user's marks; when the user marks nothing it degrades to
    // purely the bank's number.
    const marks: BillPaymentMark[] = billPaymentMarks.map((m) => ({
      billId: m.billId,
      dueDate: m.dueDate,
      state: m.state,
      amountCents: m.amountCents,
      markedDate: m.markedDate,
    }));
    heldOccurrences = findHeldOccurrences(reconcilableBills, paidOccurrencesByBill, marks, {
      today,
    });
    for (const h of heldOccurrences) {
      const list = heldByBill.get(h.billId) ?? [];
      list.push(h);
      heldByBill.set(h.billId, list);
    }
    for (const e of findExternallyPaidOccurrences(marks)) {
      const list = externallyPaidByBill.get(e.billId) ?? [];
      list.push({ date: e.dueDate, amountCents: e.amountCents });
      externallyPaidByBill.set(e.billId, list);
    }
    const attributedCents = heldOccurrences.reduce((s, h) => s + h.amountCents, 0);
    unattributedPendingCents = Math.max(0, observedFloatCents - attributedCents);

    // A mark must stay reversible: answering removes the occurrence from the
    // alert, so the alert can't also be where you take the answer back.
    //
    // But only while the answer is still the best thing we know. A `sent` mark
    // is a promise that money is on its way; once the payment actually posts
    // and reconciles, the promise has been kept and the row has nothing left
    // to say. Reality beats every claim — the same rule findHeldOccurrences
    // applies when it releases the cash hold. Without this the two halves
    // disagree: the hold clears on posting while the "sent, awaiting post"
    // line sits in the In flight band forever, telling the user money is
    // outstanding that the app has already seen land (2026-08-30).
    const billNames = new Map(cashBills.map((b) => [b.id, b] as const));
    answeredOccurrences = marks
      .filter((m) => billNames.has(m.billId))
      .filter(
        (m) => !(paidOccurrencesByBill.get(m.billId) ?? []).some((p) => p.date === m.dueDate),
      )
      .map((m) => {
        const bill = billNames.get(m.billId)!;
        const planned =
          (billOverridesByBill.get(m.billId) ?? []).find((o) => o.date === m.dueDate)?.amountCents ??
          bill.amountCents;
        return {
          billId: m.billId,
          billName: bill.name,
          dueDate: m.dueDate,
          state: m.state,
          amountCents: m.amountCents ?? planned,
        };
      })
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.billName.localeCompare(b.billName));

    // The inverse of the paid markers: recently-due occurrences nothing paid.
    // An occurrence the user already answered for is not an open question.
    const answeredKeys = new Set(marks.map((m) => occurrenceKey(m.billId, m.dueDate)));
    unpaidRecentOccurrences = findUnpaidRecentOccurrences(
      reconcilableBills,
      paidOccurrencesByBill,
      { today, answeredKeys },
    );
  }
  // Each draft on date D subtracts amountCents from the running balance
  // (positive = expense, negative = refund flows to income). To make a
  // forward walk land at liveBalance on `today`, seed the start-of-startDate
  // balance with liveBalance + Σ amountCents — the walk subtracts that sum
  // off as it crosses the historical window, leaving liveBalance at today.
  const historicalDeltaSum = historicalDrafts.reduce((sum, d) => sum + d.amountCents, 0);
  const effectiveStartingBalance = lookback
    ? (linkedBalance as number) + historicalDeltaSum
    : (linkedBalance ?? settings.startingBalanceCents);

  // Only consider scheduled events on/after startDate, except in lookback
  // mode where past events render as zero-amount "paid" markers via the
  // settledBeforeDate mechanism (and would otherwise be filtered out here).
  const onOrAfterStart = (iso: string) => lookback || iso >= startDate;
  // Settle-before pivot:
  //   - Manual mode: the as-of date — the balance is taken on that date, so
  //     anything strictly before it is already inside it.
  //   - Linked + lookback: tomorrow. The live balance reflects everything that
  //     posted through today, including today's drafts; today's scheduled
  //     events (which would otherwise double-count with drafts) become paid
  //     markers, and the projection's first "live" cash-impact row is
  //     tomorrow.
  //   - Linked, no lookback: today. There are no past rows to render anyway.
  const settleBefore = lookback ? addDaysIso(today, 1) : linked ? today : startDate;

  // Shared markers for all credit-card-derived CASH extras: they need to be
  // settled-before-today in lookback mode so past-dated cycles don't
  // re-debit the running balance (the live Plaid balance already reflects
  // any payment that actually cleared). Zero-cash due markers are exempt —
  // they never move the balance, and turning a past-dated one into a "paid"
  // marker would wrongly imply the statement was settled.
  //
  // USER-SCHEDULED cash (calendar planned payments / paydowns, one-time
  // expenses) pivots at `today`, not the lookback pivot: the live balance
  // reflects a plan only once the payment actually posts, so a plan dated
  // TODAY must stay a live, movable, cash-debiting event — not a phantom
  // "settled" marker. Once the date passes, reality (posted drafts in the
  // live balance) carries the effect and the plan settles like everything
  // else.
  const decorateScheduledExtra = <T extends OneTimeExpense>(e: T): T =>
    // Skipped rows are exempt like due markers: no cash ever left checking, so
    // pivoting one into a "paid" marker would assert the full original amount
    // settled — the opposite of what the user recorded.
    lookback && !e.dueMarker && !e.skipped
      ? {
          ...e,
          settledBeforeDate: e.userScheduled ? today : settleBefore,
          showSettledBeforeDate: true,
        }
      : e;

  const historicalExtras: OneTimeExpense[] = historicalDrafts.map((d) => ({
    date: d.date,
    description: d.merchantName ?? d.description,
    amountCents: d.amountCents,
  }));

  const input: ProjectionInput = {
    startingBalanceCents: effectiveStartingBalance,
    startDate,
    endDate,
    paychecks: paychecks
      .filter((p) => onOrAfterStart(p.payDate))
      .map((p) => {
        // In linked mode the live balance already reflects any deposit that has
        // actually posted, so a paycheck settled by a real deposit must not be
        // re-added as future income even when its scheduled payDate is still
        // ahead (payroll posts early before a weekend/holiday). settledByDraftId
        // — not the manual actualReceived toggle — is the deposit-backed signal
        // that the cash is truly in the live balance.
        const depositPosted = linked && p.settledByDraftId != null;
        return {
          payDate: p.payDate,
          amountCents:
            p.actualReceived && p.actualAmountCents != null ? p.actualAmountCents : p.amountCents,
          note: p.note,
          settledBeforeDate: settleBefore,
          settled: depositPosted,
          // Render the received occurrence as a paid marker (zero cash) instead
          // of dropping it, so an early-posted paycheck still shows up.
          showSettledBeforeDate: lookback || depositPosted,
        };
      }),
    bills: [
      ...cashBills.map((b) => ({
        id: b.id,
        name: b.name,
        amountCents: b.amountCents,
        intervalMonths: b.intervalMonths,
        anchorDate: b.anchorDate,
        paymentOverrides: billOverridesByBill.get(b.id) ?? [],
        paidOccurrences: paidOccurrencesByBill.get(b.id) ?? [],
        externallyPaidOccurrences: externallyPaidByBill.get(b.id) ?? [],
        heldOccurrences: (heldByBill.get(b.id) ?? []).map((h) => ({
          date: h.dueDate,
          amountCents: h.amountCents,
          reason: h.reason,
          holdDate: h.holdDate,
        })),
        settledBeforeDate: settleBefore,
        // `autoPay` means the biller will pull it, not that the pull has
        // landed — so it still only decides whether an already-settled
        // occurrence RENDERS. Whether an occurrence settles at all is now
        // decided by evidence (heldOccurrences), above.
        showSettledBeforeDate: lookback || (linked && b.autoPay),
      })),
      ...cardChargedBills.map((b) => ({
        id: b.id,
        name: b.name,
        amountCents: b.amountCents,
        intervalMonths: b.intervalMonths,
        anchorDate: b.anchorDate,
        paymentOverrides: billOverridesByBill.get(b.id) ?? [],
        chargedToCardName: cardNameById.get(b.paidViaCardId!),
      })),
    ],
    extras: [
      ...extras
        .filter((e) => onOrAfterStart(e.date))
        .filter((e) => e.paidViaCardId == null || !activeCardIds.has(e.paidViaCardId))
        .map((e) => {
          // A one-time expense the user allocated part of a real transaction
          // to is settled by evidence, not by its date passing: zero cash,
          // showing what actually posted. This is the only way an extra ever
          // gets reconciled — see matchPaidBillOccurrences' note on why
          // heuristic name matching is unsafe for one-offs.
          const paid = paidExtraById.get(e.id);
          if (paid) {
            return {
              date: e.date,
              description: e.description,
              amountCents: 0,
              originalAmountCents: paid.paidAmountCents,
              isPaid: true,
            };
          }
          return decorateScheduledExtra({
            date: e.date,
            description: e.description,
            amountCents: e.amountCents,
            settledBeforeDate: settleBefore,
            showSettledBeforeDate: lookback,
            userScheduled: true,
          });
        }),
      // Card-charged one-time expenses: zero-cash markers (see cardChargedBills).
      ...extras
        .filter((e) => onOrAfterStart(e.date))
        .filter((e) => e.paidViaCardId != null && activeCardIds.has(e.paidViaCardId))
        .map((e) => ({
          date: e.date,
          description: e.description,
          amountCents: 0,
          originalAmountCents: e.amountCents,
          chargedToCardName: cardNameById.get(e.paidViaCardId!),
        })),
      ...cardPayments.extras.filter((e) => onOrAfterStart(e.date)).map(decorateScheduledExtra),
      ...historicalExtras,
      // Pending spend the bank is reporting that no bill occurrence explains —
      // a card swipe, a transfer, anything that hasn't posted. Deliberately
      // NOT passed through decorateScheduledExtra: it carries no
      // settledBeforeDate at all, because the whole point is that this money
      // is NOT yet inside the live balance the walk starts from, even though
      // it rides today. It disappears on its own the moment the transaction
      // posts and `current` catches up with `available`.
      ...(unattributedPendingCents > 0
        ? [
            {
              date: today,
              description: "Pending at bank",
              amountCents: unattributedPendingCents,
              awaitingPost: true,
            },
          ]
        : []),
    ],
  };
  const promoSummariesByCard: Record<string, PromoPaymentSummary[]> = {};
  for (const promo of promos) {
    if (!promo.isActive || promo.remainingAmountCents <= 0 || !activeCardIds.has(promo.cardId)) continue;
    const list = promoSummariesByCard[promo.cardId] ?? [];
    list.push({
      id: promo.id,
      cardId: promo.cardId,
      description: promo.description,
      remainingAmountCents: promo.remainingAmountCents,
      endDate: promo.endDate,
      monthlyPaymentCents: promo.monthlyPaymentCents,
    });
    promoSummariesByCard[promo.cardId] = list;
  }
  for (const list of Object.values(promoSummariesByCard)) {
    list.sort((a, b) => a.endDate.localeCompare(b.endDate));
  }

  return {
    rows: computeProjection(input),
    startDate,
    endDate,
    today,
    startingBalanceCents: effectiveStartingBalance,
    projectionMonths: settings.projectionMonths,
    currency: settings.currency,
    promoSummariesByCard,
    promoDriftByCard: cardPayments.promoDriftByCard,
    variableBillCategoriesByKey: cardPayments.variableBillCategoriesByKey,
    billMatchesByDraftId,
    paidOccurrencesByBill: paidOccurrencesByBillOut,
    unpaidRecentOccurrences,
    pendingPosting: {
      bills: heldOccurrences,
      answered: answeredOccurrences,
      bankPendingOutflowCents: linked ? observedFloatCents : 0,
      attributedCents: heldOccurrences.reduce((s, h) => s + h.amountCents, 0),
      unattributedCents: unattributedPendingCents,
      totalHeldCents:
        heldOccurrences.reduce((s, h) => s + h.amountCents, 0) + unattributedPendingCents,
    },
  };
}
