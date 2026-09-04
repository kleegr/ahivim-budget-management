import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft, Settings2 } from "lucide-react";
import AgencyProfile from "@/components/agencies/agency-profile";
import { ErrorPanel, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import {
  canAccessPortalAgency,
  isPortalOwner,
  resolvePortalAccess,
} from "@/lib/auth/portal-access";
import { agencyDate } from "@/lib/business/agency-time";
import { getAgencyProfileReadModel } from "@/lib/data/agency-profile";
import { normalizePortalMonth } from "@/lib/data/portal-read-model";
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
    if (!canAccessPortalAgency(portal, id)) {
      return { denied: true as const, owner: isPortalOwner(portal), profile: null };
    }
    return {
      denied: false as const,
      owner: isPortalOwner(portal),
      profile: await getAgencyProfileReadModel(pool, portal, id, month, agencyDate()),
    };
  });

  if (result.ok && result.data.denied) {
    redirect(result.data.owner ? "/home?denied=1" : "/portal?denied=1");
  }
  if (result.ok && !result.data.profile) notFound();

  const profile = result.ok ? result.data.profile : null;
  const agency = profile?.agency ?? null;
  const previewAction = profile?.permissions.isOwner ? (
    profile.previewAccounts.length > 0 ? (
      <form
        action="/api/auth/impersonation/start"
        method="post"
        className="flex flex-wrap items-center gap-2"
        title="Open an actual server-authorized account linked to this agency"
      >
        {profile.previewAccounts.length === 1 ? (
          <input type="hidden" name="targetUserId" value={profile.previewAccounts[0]!.userId} />
        ) : (
          <>
            <label className="sr-only" htmlFor="agency-portal-preview-account">Agency portal account</label>
            <select id="agency-portal-preview-account" name="targetUserId" className="input h-9 min-w-44 text-sm">
              {profile.previewAccounts.map((account) => (
                <option key={`${account.userId}-${account.role}`} value={account.userId}>
                  {account.displayName} · {account.role.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </>
        )}
        <button type="submit" className="btn btn-sm btn-primary">Preview Agency portal</button>
      </form>
    ) : (
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        disabled
        title="Link an active agency account first"
      >
        Preview Agency portal
      </button>
    )
  ) : null;

  return (
    <>
      <PageHeader
        eyebrow={agency ? `${agency.code} · Agency 360` : "Agency 360"}
        title={agency?.name ?? "Agency unavailable"}
        description={profile?.permissions.isOwner
          ? "Dated rosters, authorizations, schedules, assignments, actual financial sources, and linked access in one workspace."
          : "Your capability-scoped view of this agency’s dated roster, authorized hours, schedules, assignments, and permitted financial activity."}
        action={agency && profile ? (
          <div className="flex flex-wrap items-center gap-2">
            {previewAction}
            {profile.permissions.isOwner ? (
              <>
                <Link href={`/agencies?month=${agency.month}`} className="btn btn-ghost btn-sm"><ChevronLeft aria-hidden className="h-4 w-4" /> Agencies</Link>
                <Link href="/settings/agencies" className="btn btn-secondary btn-sm"><Settings2 aria-hidden className="h-4 w-4" /> Manage setup</Link>
              </>
            ) : (
              <Link href="/portal" className="btn btn-ghost btn-sm"><ChevronLeft aria-hidden className="h-4 w-4" /> My portal</Link>
            )}
          </div>
        ) : undefined}
      />
      {!result.ok ? (
        <ErrorPanel title="Agency profile could not load">{result.error}</ErrorPanel>
      ) : profile ? <AgencyProfile profile={profile} /> : null}
    </>
  );
}
