import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft, Settings2 } from "lucide-react";
import AgencyProfile from "@/components/agencies/agency-profile";
import { ErrorPanel, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { hasPortalCapability, isPortalOwner, resolvePortalAccess } from "@/lib/auth/portal-access";
import { buildAgencyDirectoryReadModel, findAgencyDirectoryEntry } from "@/lib/data/agency-directory";
import { getPortalHomeReadModel, normalizePortalMonth } from "@/lib/data/portal-read-model";
import { withDb } from "@/lib/data/pool";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agency profile - Ahivim Budget Management" };

export default async function AgencyProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const user = await requireUser("viewer");
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const month = normalizePortalMonth(query.month);
  const result = await withDb(async (pool) => {
    const portal = await resolvePortalAccess(pool, user);
    if (!isPortalOwner(portal) || !hasPortalCapability(portal, "agencies.read")) return { denied: true as const, agency: null };
    const directory = buildAgencyDirectoryReadModel(await getPortalHomeReadModel(
      pool,
      portal,
      month,
      { agencyIds: [id] },
    ));
    return { denied: false as const, agency: findAgencyDirectoryEntry(directory, id) };
  });

  if (result.ok && result.data.denied) redirect("/portal?denied=1");
  if (result.ok && !result.data.agency) notFound();

  const agency = result.ok ? result.data.agency : null;
  return (
    <>
      <PageHeader
        eyebrow={agency ? `${agency.code} · Agency profile` : "Agency profile"}
        title={agency?.name ?? "Agency unavailable"}
        description="A single operational view of roster membership, budget usage, schedules, actual activity, and permitted financial totals."
        action={agency ? (
          <>
            <Link href={`/agencies?month=${agency.month}`} className="btn btn-ghost btn-sm"><ChevronLeft aria-hidden className="h-4 w-4" /> Agencies</Link>
            <Link href="/settings/agencies" className="btn btn-secondary btn-sm"><Settings2 aria-hidden className="h-4 w-4" /> Manage setup</Link>
          </>
        ) : undefined}
      />
      {!result.ok ? (
        <ErrorPanel title="Agency profile could not load">{result.error}</ErrorPanel>
      ) : agency ? <AgencyProfile agency={agency} /> : null}
    </>
  );
}
