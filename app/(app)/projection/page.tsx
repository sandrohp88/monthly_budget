import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { buildProjection } from "@/lib/projection-server";
import { DateLabel } from "@/components/date-label";
import { ProjectionClient } from "./projection-client";

export const dynamic = "force-dynamic";

export default async function ProjectionPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const projection = await buildProjection(userId);
  if (!projection) redirect("/setup");
  const { rows, startDate, endDate, today, promoSummariesByCard, variableBillCategoriesByKey } =
    projection;

  return (
    <div className="fade-in space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 text-[13px] font-medium text-[var(--text-3)]">Projection</div>
          <div
            role="heading"
            aria-level={1}
            className="text-[34px] leading-none font-semibold tracking-normal text-[var(--text-0)]"
          >
            Ledger
          </div>
          <p className="mt-2 text-[14px] text-[var(--text-2)]">
            Daily cash-flow from <DateLabel iso={startDate} format="short" /> to{" "}
            <DateLabel iso={endDate} format="short" /> · {rows.length} days
          </p>
        </div>
      </div>
      <ProjectionClient
        rows={rows}
        startDate={startDate}
        endDate={endDate}
        today={today}
        promoSummariesByCard={promoSummariesByCard}
        variableBillCategories={variableBillCategoriesByKey}
      />
    </div>
  );
}
