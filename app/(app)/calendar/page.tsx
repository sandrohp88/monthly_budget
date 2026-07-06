import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { buildProjection } from "@/lib/projection-server";
import { listCategories, listCreditCards } from "@/lib/repos";
import { CalendarClient } from "./calendar-client";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const [projection, categories, cards] = await Promise.all([
    buildProjection(userId),
    listCategories(userId),
    listCreditCards(userId, true),
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
          Upcoming bills, paychecks, and card payments — click a day for detail or to add a bill
        </p>
      </div>
      <CalendarClient
        rows={projection.rows}
        today={projection.today}
        startDate={projection.startDate}
        endDate={projection.endDate}
        categories={categories.filter((c) => c.kind === "expense").map((c) => c.name)}
        cards={cards.map((c) => ({ id: c.id, name: c.name, isActive: c.isActive }))}
      />
    </div>
  );
}
