import Link from "next/link";
import { redirect } from "next/navigation";
import { Settings2 } from "lucide-react";
import AgencyDirectory from "@/components/agencies/agency-directory";
import { ErrorPanel, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { hasPortalCapability, isPortalOwner, resolvePortalAccess } from "@/lib/auth/portal-access";
import { buildAgencyDirectoryReadModel } from "@/lib/data/agency-directory";
import { getPortalHomeReadModel, normalizePortalMonth } from "@/lib/data/portal-read-model";
import { withDb } from "@/lib/data/pool";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agencies - Ahivim Budget Management" };

export default async function AgenciesPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; q?: string }>;
}) {
  const user = await requireUser("viewer");
  const params = await searchParams;
  const month = normalizePortalMonth(params.month);
  const query = params.q?.trim() ?? "";
  const result = await withDb(async (pool) => {
    const portal = await resolvePortalAccess(pool, user);
    if (!isPortalOwner(portal) || !hasPortalCapability(portal, "agencies.read")) return null;
    return buildAgencyDirectoryReadModel(await getPortalHomeReadModel(
      pool,
      portal,
      month,
      { agencySummaryOnly: true },
    ));
  });

  if (result.ok && result.data === null) redirect("/portal?denied=1");

  return (
    <>
      <PageHeader
        eyebrow="Owner workspace"
        title="Agencies"
        description="Current rosters, budget responsibility, schedules, and recorded activity by agency."
        action={(
          <Link href="/settings/agencies" className="btn btn-secondary btn-sm">
            <Settings2 aria-hidden className="h-4 w-4" /> Manage setup
          </Link>
        )}
      />
      {!result.ok ? (
        <ErrorPanel title="Agency directory could not load">{result.error}</ErrorPanel>
      ) : result.data ? <AgencyDirectory directory={result.data} query={query} /> : null}
    </>
  );
}
