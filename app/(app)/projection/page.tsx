import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * The Projection page merged into /ledger (which renders the same table via
 * ProjectionClient plus insights and the Reports tab). Kept as a redirect so
 * old bookmarks and deep links keep working.
 */
export default function ProjectionRedirect() {
  redirect("/ledger");
}
