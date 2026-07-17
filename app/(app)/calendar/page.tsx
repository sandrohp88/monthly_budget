import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { buildProjection } from "@/lib/projection-server";
import {
  getSettings,
  listCategories,
  listCreditCards,
  listCreditCardPaymentOverridesForUser,
} from "@/lib/repos";
import { DEFAULT_TIMEZONE } from "@/lib/dates";
import { CalendarClient } from "./calendar-client";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const [projection, categories, cards, overrides, settings] = await Promise.all([
    buildProjection(userId),
    listCategories(userId),
    listCreditCards(userId, true),
    listCreditCardPaymentOverridesForUser(userId),
    getSettings(userId),
  ]);
  if (!projection) redirect("/setup");

  return (
    <div className="fade-in space-y-5">
      <div>
        <div className="mb-2 text-[13px] font-medium text-[var(--text-3)]">Cash flow</div>
        <div
          role="heading"
          aria-level={1}
          className="text-[34px] leading-none font-semibold tracking-normal text-[var(--text-0)]"
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
        categories={categories.filter((c) => c.kind === "expense").map((c) => c.name)}
        cards={cards.map((c) => ({ id: c.id, name: c.name, isActive: c.isActive }))}
        overrides={overrides.map((o) => ({ cardId: o.cardId, dueDate: o.dueDate }))}
        timezone={settings?.timezone ?? DEFAULT_TIMEZONE}
      />
    </div>
  );
}
