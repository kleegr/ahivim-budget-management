import { agencyDate } from "@/lib/business/agency-time";
import {
  canAccessPortalAgency,
  hasPortalCapability,
  isPortalOwner,
  type PortalAccessContext,
} from "@/lib/auth/portal-access";
import type { PgLikePool } from "@/lib/import/commit";
import {
  filterPlanningWorkspaceForAgency,
  getPlanningWorkspace,
  type PlanningAssignmentRow,
  type PlanningAuthorizationGap,
  type PlanningCoverageRow,
  type PlanningSeriesRow,
  type PlanningWorkItem,
  type PlanningWorkspaceData,
} from "@/lib/data/planning-queries";
import {
  getPortalHomeReadModel,
  type PortalAgencySummary,
} from "@/lib/data/portal-read-model";
import {
  listAgencyEmployeeMemberships,
  listAgencyIndividualMemberships,
  listAgencyUserAccess,
  type AgencyEmployeeMembershipRecord,
  type AgencyIndividualMembershipRecord,
  type AgencyUserAccessRecord,
} from "@/lib/manage/agencies";

export interface AgencyProfilePermissions {
  isOwner: boolean;
  canReadPeople: boolean;
  canReadHours: boolean;
  canReadSchedules: boolean;
  canReadAssignments: boolean;
}

export interface AgencyProfilePlanning {
  coverage: PlanningCoverageRow[] | null;
  workQueue: PlanningWorkItem[] | null;
  authorizationGaps: PlanningAuthorizationGap[] | null;
  assignments: PlanningAssignmentRow[] | null;
  series: PlanningSeriesRow[] | null;
  summary: PlanningWorkspaceData["summary"] | null;
}

export interface AgencyProfilePreviewAccount {
  userId: string;
  displayName: string;
  email: string;
  role: AgencyUserAccessRecord["role"];
}

export interface AgencyProfileReadModel {
  agency: PortalAgencySummary;
  asOf: string;
  permissions: AgencyProfilePermissions;
  individualRoster: AgencyIndividualMembershipRecord[] | null;
  employeeRoster: AgencyEmployeeMembershipRecord[] | null;
  planning: AgencyProfilePlanning | null;
  linkedUsers: AgencyUserAccessRecord[] | null;
  previewAccounts: AgencyProfilePreviewAccount[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Compose one agency workspace from the existing portal-safe financial model,
 * dated membership history, and the canonical planning model. This module does
 * not calculate money or authorization usage; it only applies capability and
 * agency boundaries to those established read models.
 */
export async function getAgencyProfileReadModel(
  pool: PgLikePool,
  context: PortalAccessContext,
  agencyId: string,
  requestedMonth?: string | null,
  requestedAsOf: string = agencyDate(),
): Promise<AgencyProfileReadModel | null> {
  if (!canAccessPortalAgency(context, agencyId)) return null;

  const permissions: AgencyProfilePermissions = {
    isOwner: isPortalOwner(context),
    canReadPeople: hasPortalCapability(context, "people.agency.read", agencyId),
    canReadHours: hasPortalCapability(context, "hours_budgets.agency.read", agencyId),
    canReadSchedules: hasPortalCapability(context, "schedules.agency.read", agencyId),
    canReadAssignments: hasPortalCapability(context, "assignments.agency.manage", agencyId),
  };
  const loadPlanning = permissions.canReadPeople && (
    permissions.canReadHours
    || permissions.canReadSchedules
    || permissions.canReadAssignments
  );

  const individualRosterPromise = permissions.canReadPeople
    ? listAgencyIndividualMemberships(pool, agencyId)
    : Promise.resolve(null);
  const employeeRosterPromise = permissions.canReadPeople
    ? listAgencyEmployeeMemberships(pool, agencyId)
    : Promise.resolve(null);

  const [portal, individualRoster, employeeRoster, planningRaw, linkedUsers] = await Promise.all([
    getPortalHomeReadModel(pool, context, requestedMonth, { agencyIds: [agencyId] }),
    individualRosterPromise,
    employeeRosterPromise,
    loadPlanning
      ? getPlanningWorkspace(pool, requestedAsOf, undefined, [agencyId])
      : Promise.resolve(null),
    permissions.isOwner ? listAgencyUserAccess(pool, agencyId) : Promise.resolve(null),
  ]);
  const agency = portal.agencies.find((candidate) => candidate.id === agencyId);
  if (!agency) return null;

  let planning: AgencyProfilePlanning | null = null;
  if (planningRaw && individualRoster && employeeRoster) {
    const exact = filterPlanningWorkspaceForAgency(planningRaw, [{
      agencyId,
      individualIds: unique(individualRoster.map((entry) => entry.individualId)),
      employeeIds: unique(employeeRoster.map((entry) => entry.employeeId)),
      individualMemberships: individualRoster
        .filter((entry) => entry.isActive)
        .map((entry) => ({
          subjectId: entry.individualId,
          effectiveFrom: entry.effectiveFrom,
          effectiveTo: entry.effectiveTo,
        })),
      employeeMemberships: employeeRoster
        .filter((entry) => entry.isActive)
        .map((entry) => ({
          subjectId: entry.employeeId,
          effectiveFrom: entry.effectiveFrom,
          effectiveTo: entry.effectiveTo,
        })),
    }]);
    planning = {
      coverage: permissions.canReadHours ? exact.coverage : null,
      workQueue: permissions.canReadSchedules ? exact.workQueue : null,
      authorizationGaps: permissions.canReadHours ? exact.authorizationGaps : null,
      assignments: permissions.canReadAssignments ? exact.assignments : null,
      series: permissions.canReadSchedules ? exact.series : null,
      summary: permissions.canReadSchedules ? exact.summary : null,
    };
  }

  const previewAccounts = (linkedUsers ?? [])
    .filter((entry) => entry.isActive && entry.userId !== context.userId)
    .sort((left, right) => (
      Number(right.role === "agency") - Number(left.role === "agency")
      || left.displayName.localeCompare(right.displayName)
    ))
    .map((entry) => ({
      userId: entry.userId,
      displayName: entry.displayName,
      email: entry.email,
      role: entry.role,
    }));

  return {
    agency,
    asOf: requestedAsOf,
    permissions,
    individualRoster,
    employeeRoster,
    planning,
    linkedUsers,
    previewAccounts,
  };
}
