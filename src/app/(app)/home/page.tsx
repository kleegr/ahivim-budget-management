import { redirect } from "next/navigation";
import { currentUser, roleAtLeast } from "@/lib/auth/session";
import { canAccessPlanning, resolveAccessScope } from "@/lib/auth/access";
import { withDb } from "@/lib/data/pool";
import { agencyIdsWithPlanningAccess, resolvePortalAccess } from "@/lib/auth/portal-access";
import { resolveAccountProfile } from "@/lib/auth/account-label";
import { buildRoleHomeDefinition } from "@/lib/dashboard/role-home";
import { viewerHomePath, withDeniedNotice } from "@/lib/nav/home-route";
import RoleHome from "@/components/dashboard/role-home";

export const dynamic = "force-dynamic";

/**
 * `/home` is the canonical landing route. Managers and admins land on the
 * dashboard overview. Internal viewer presets receive a role-led Home built
 * from their effective permissions. External identities continue into their
 * real Portal or agency-scoped Schedule rather than a simulated dashboard.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const denied = params.denied === "1";
  const user = await currentUser();
  if (!user) redirect("/signin");
  if (roleAtLeast(user.role, "manager")) redirect(withDeniedNotice("/dashboard", denied));

  const resolved = await withDb(async (pool) => {
    const [access, portal] = await Promise.all([
      resolveAccessScope(pool, user),
      resolvePortalAccess(pool, user),
    ]);
    return { access, portal };
  });
  if (resolved.ok) {
    const { access, portal } = resolved.data;
    const profile = resolveAccountProfile(user.role, access, portal, user.accountPreset);
    if (profile.id === "portal") {
      redirect(withDeniedNotice(viewerHomePath(access, portal), denied));
    }
    const externalPreset = [
      "individual_parent",
      "employee",
      "agency",
      "agency_scheduler",
      "agency_staffing_manager",
      "agency_collector",
    ].includes(profile.id);
    if (externalPreset) {
      redirect(withDeniedNotice(viewerHomePath(access, portal), denied));
    }

    const internalPlanning = canAccessPlanning(access);
    const canPlan = internalPlanning || agencyIdsWithPlanningAccess(portal).length > 0;
    const canSeeEmployees = internalPlanning
      || access.full
      || access.allEmployees
      || access.employeeIds.length > 0;
    return (
      <RoleHome
        definition={buildRoleHomeDefinition(profile.id, {
          canSeeBudgets: access.canSeeBudgets,
          canSeeEmployees,
          canSeeTransactions: access.canSeeTransactions,
          canPlan,
          canSeeSettlements: access.canSeeSettlements,
          canSeeClassFinancials: access.canSeeClassFinancials,
          canViewDocuments: access.canViewDocuments,
          canUsePortal:
            portal.globalRoles.length > 0
            || portal.agencyAccess.length > 0
            || portal.individualLinks.length > 0
            || portal.employeeLinks.length > 0,
        })}
      />
    );
  }
  redirect(withDeniedNotice("/settings", denied));
}
