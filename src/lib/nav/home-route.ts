import { canAccessPlanning, type AccessScope } from "@/lib/auth/access";
import { agencyIdsWithPlanningAccess, type PortalAccessContext } from "@/lib/auth/portal-access";

/** Choose the first useful workspace for a capability-scoped viewer. */
export function viewerHomePath(access: AccessScope, portal: PortalAccessContext): string {
  const agencyRoles = new Set(portal.agencyAccess.map((assignment) => assignment.role));
  if (
    canAccessPlanning(access)
    || agencyIdsWithPlanningAccess(portal).length > 0
  ) return "/schedule";
  if (access.canSeeSettlements && agencyRoles.has("collector")) return "/masser";

  const externalPortal = portal.globalRoles.some((assignment) => assignment.role !== "owner")
    || portal.agencyAccess.length > 0
    || portal.individualLinks.length > 0
    || portal.employeeLinks.length > 0;
  if (externalPortal) return "/portal";
  if (access.canSeeBudgets) return "/individuals";
  if (access.canSeeSettlements) return "/masser";
  if (access.canSeeTransactions) return "/transactions";
  if (access.canSeeClassFinancials) return "/classes";
  if (access.canViewDocuments) return "/documents";
  if (access.full || access.allEmployees || access.employeeIds.length > 0) return "/employees";
  return "/settings";
}

/** Preserve a denied deep-link explanation while routing a viewer to their workspace. */
export function withDeniedNotice(path: string, denied: boolean): string {
  if (!denied) return path;
  const url = new URL(path, "https://ahivim.local");
  url.searchParams.set("denied", "1");
  return `${url.pathname}${url.search}${url.hash}`;
}
