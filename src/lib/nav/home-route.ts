import { canAccessPlanning, type AccessScope } from "@/lib/auth/access";
import { agencyIdsWithPlanningAccess, type PortalAccessContext } from "@/lib/auth/portal-access";

/** Choose the first useful workspace for a capability-scoped viewer. */
export function viewerHomePath(access: AccessScope, portal: PortalAccessContext): string {
  const agencyRoles = new Set(portal.agencyAccess.map((assignment) => assignment.role));
  if (
    canAccessPlanning(access)
    || agencyIdsWithPlanningAccess(portal).length > 0
  ) return "/schedule";
  if (access.canSeeSettlements && agencyRoles.has("collector")) return "/collections";

  const externalPortal = portal.globalRoles.some((assignment) => assignment.role !== "owner")
    || portal.agencyAccess.length > 0
    || portal.individualLinks.length > 0
    || portal.employeeLinks.length > 0;
  if (externalPortal) return "/portal";
  if (access.canSeeBudgets) return "/individuals";
  if (access.canSeeSettlements) return "/collections";
  if (access.canSeeTransactions) return "/transactions";
  if (access.canSeeClassFinancials) return "/classes";
  if (access.canEditDocuments) return "/documents";
  if (access.full || access.allEmployees || access.employeeIds.length > 0) return "/employees";
  return "/settings";
}
