import { redirect } from "next/navigation";
import { requirePageUser } from "@/lib/auth";
import { buildProjection } from "@/lib/projection-server";
import {
  getSettings,
  listCategories,
  listCreditCards,
  listCreditCardPaymentOverridesForUser,
  listPlaidAccounts,
  listStartingBalanceDraftsInRange,
} from "@/lib/repos";
import { addDaysIso, DEFAULT_TIMEZONE } from "@/lib/dates";
import { MAX_LOOKBACK_DAYS } from "@/lib/projection";
import { CalendarClient } from "./calendar-client";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const { id: userId } = await requirePageUser();

  const [projection, categories, cards, overrides, settings, accounts] = await Promise.all([
    buildProjection(userId),
    listCategories(userId),
    listCreditCards(userId, true),
    listCreditCardPaymentOverridesForUser(userId),
    getSettings(userId),
    listPlaidAccounts(userId),
  ]);
  if (!projection) redirect("/setup");

  // Posted drafts on cash accounts for days strictly BEFORE projection.startDate.
  // Inclusive repo range → end at the day before startDate. Never overlaps rows.
  const historyFloor = addDaysIso(projection.today, -MAX_LOOKBACK_DAYS);
  const historyEndInclusive =
    historyFloor < projection.startDate ? addDaysIso(projection.startDate, -1) : null;
  const historyDrafts =
    historyEndInclusive != null
      ? await listStartingBalanceDraftsInRange(userId, historyFloor, historyEndInclusive)
      : [];
  const history = historyDrafts.map((d) => ({
    id: d.id,
    date: d.date,
    description: (d.merchantName?.trim() || d.description).trim() || d.description,
    amountCents: d.amountCents,
  }));

  // Credit line + balance per card, for the utilization bar on card events.
  // Balance resolves the same way the wallet's first two fallbacks do
  // (manual/synced card balance, then the linked account's live balance).
  // The wallet's third fallback — deriving a floor from unpaid statements and
  // promo principal — is deliberately skipped: it needs a per-card statement
  // and promo query, and an inferred floor is a poor basis for a utilization
  // percentage. A card with no known balance simply shows no bar.
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const cardCredit = cards.map((c) => {
    const account = c.plaidAccountId ? accountById.get(c.plaidAccountId) : undefined;
    return {
      id: c.id,
      name: c.name,
      isActive: c.isActive,
      balanceCents: c.currentBalanceCents ?? account?.balanceCents ?? null,
      creditLimitCents: c.creditLimitCents ?? account?.limitCents ?? null,
    };
  });

  return (
    <div className="fade-in space-y-5">
      <div>
        <div className="mb-2 text-[13px] font-medium text-[var(--text-3)]">Cash flow</div>
        <div
          role="heading"
          aria-level={1}
          className="text-[28px] font-extrabold leading-[1.15] tracking-[-0.01em] text-[var(--text-0)] md:text-[36px]"
        >
          Calendar
        </div>
        <p className="mt-2 text-[14px] text-[var(--text-2)]">
          Every card due date, color-coded by how much you&apos;ve scheduled to pay — unpaid
          balances warn about interest instead of draining your cash
        </p>
      </div>
      <CalendarClient
        rows={projection.rows}
        today={projection.today}
        startDate={projection.startDate}
        endDate={projection.endDate}
        history={history}
        categories={categories.filter((c) => c.kind === "expense").map((c) => c.name)}
        cards={cardCredit}
        overrides={overrides.map((o) => ({ cardId: o.cardId, dueDate: o.dueDate }))}
        timezone={settings?.timezone ?? DEFAULT_TIMEZONE}
      />
    </div>
  );
}
