import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { buildProjection } from "@/lib/projection-server";
import { PageHead } from "@/components/ui/page-head";
import { DateLabel } from "@/components/date-label";
import { ProjectionClient } from "./projection-client";

export const dynamic = "force-dynamic";

export default async function ProjectionPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect("/login");

  const projection = await buildProjection(userId);
  if (!projection) redirect("/setup");
  const { rows, startDate, endDate, today, promoSummariesByCard, variableBillCategoriesByKey } = projection;

  return (
    <div className="space-y-6 fade-in">
      <PageHead
        module="MODULE_05"
        title="PROJECTION"
        subtitle={
          <>
            Daily ledger · <DateLabel iso={startDate} format="short" /> –{" "}
            <DateLabel iso={endDate} format="short" /> · {rows.length} days
          </>
        }
      />
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
