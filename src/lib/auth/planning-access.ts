import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { canAccessPlanning, resolveAccessScope, type AccessScope } from "./access";
import {
  agencyIdsWithPlanningAccess,
  hasPortalCapability,
  resolvePortalAccess,
} from "./portal-access";
import {
  apiUser,
  homePathForRole,
  requireUser,
  type AuthenticatedUser,
} from "./session";
import { agencyDate } from "@/lib/business/agency-time";

export interface PlanningMembership {
  subjectId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface PlanningDateRange {
  from: string | null;
  to: string | null;
}

export interface PlanningAccess {
  user: AuthenticatedUser;
  access: AccessScope;
  /** Empty for an internal portfolio planner; otherwise the readable agencies. */
  agencyIds: string[];
  agencyRosters: Array<{
    agencyId: string;
    individualIds: string[];
    employeeIds: string[];
    individualMemberships: PlanningMembership[];
    employeeMemberships: PlanningMembership[];
  }>;
  scheduleManageAgencyIds: string[];
  assignmentManageAgencyIds: string[];
  canManageSchedules: boolean;
  canManageAssignments: boolean;
}

interface MembershipRow {
  agency_id: string;
  subject_id: string;
  effective_from: string;
  effective_to: string | null;
}

function hoursOnlyScope(
  user: AuthenticatedUser,
  individualIds: string[],
  employeeIds: string[],
): AccessScope {
  return {
    userId: user.id,
    role: user.role,
    full: false,
    canSeeTransactions: false,
    canSeeMoney: false,
    canSeeHours: true,
    canSeeBilledAmounts: false,
    canSeeEmployeeAmounts: false,
    canSeeAgencySpread: false,
    canSeeCheckNet: false,
    canSeeTaxes: false,
    canSeeBudgets: true,
    canSeeEmployeeDeals: false,
    canSeeSettlements: false,
    canManageSettlements: false,
    canPlan: true,
    canSeeClassFinancials: false,
    canManageClassInvoices: false,
    canEditDocuments: false,
    allIndividuals: false,
    allEmployees: false,
    individualIds,
    employeeIds,
    grantedIndividualIds: individualIds,
    grantedEmployeeIds: employeeIds,
  };
}

async function resolvePlanningAccess(user: AuthenticatedUser): Promise<PlanningAccess | null> {
  const pool = getPool();
  const [access, portal] = await Promise.all([
    resolveAccessScope(pool, user),
    resolvePortalAccess(pool, user),
  ]);
  if (canAccessPlanning(access)) {
    return {
      user,
      access,
      agencyIds: [],
      agencyRosters: [],
      scheduleManageAgencyIds: [],
      assignmentManageAgencyIds: [],
      canManageSchedules: true,
      canManageAssignments: true,
    };
  }

  const agencyIds = agencyIdsWithPlanningAccess(portal);
  if (agencyIds.length === 0) return null;
  const scheduleManageAgencyIds = agencyIds.filter((agencyId) =>
    hasPortalCapability(portal, "schedules.agency.manage", agencyId));
  const assignmentManageAgencyIds = agencyIds.filter((agencyId) =>
    hasPortalCapability(portal, "assignments.agency.manage", agencyId));
  const [individualRows, employeeRows] = await Promise.all([
    pool.query<MembershipRow>(
      `SELECT agency_id, individual_id AS subject_id,
              effective_from::text, effective_to::text
         FROM agency_individuals
        WHERE agency_id = ANY($1::uuid[])
          AND is_active = true`,
      [agencyIds],
    ),
    pool.query<MembershipRow>(
      `SELECT agency_id, employee_id AS subject_id,
              effective_from::text, effective_to::text
         FROM agency_employees
        WHERE agency_id = ANY($1::uuid[])
          AND is_active = true`,
      [agencyIds],
    ),
  ]);
  const agencyRosters = agencyIds.map((agencyId) => ({
    agencyId,
    individualIds: individualRows.rows.filter((row) => row.agency_id === agencyId).map((row) => row.subject_id),
    employeeIds: employeeRows.rows.filter((row) => row.agency_id === agencyId).map((row) => row.subject_id),
    individualMemberships: individualRows.rows.filter((row) => row.agency_id === agencyId).map((row) => ({
      subjectId: row.subject_id,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
    })),
    employeeMemberships: employeeRows.rows.filter((row) => row.agency_id === agencyId).map((row) => ({
      subjectId: row.subject_id,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
    })),
  }));
  const individualIds = [...new Set(individualRows.rows.map((row) => row.subject_id))];
  const employeeIds = [...new Set(employeeRows.rows.map((row) => row.subject_id))];
  return {
    user,
    access: hoursOnlyScope(user, individualIds, employeeIds),
    agencyIds,
    agencyRosters,
    scheduleManageAgencyIds,
    assignmentManageAgencyIds,
    canManageSchedules: scheduleManageAgencyIds.length > 0,
    canManageAssignments: assignmentManageAgencyIds.length > 0,
  };
}

export function planningSubjectsAllowed(
  planning: PlanningAccess,
  subjects: { individualIds: string[]; employeeId: string | null },
  action: "read" | "schedule" | "assignment" = "read",
  range?: PlanningDateRange,
): boolean {
  if (planning.agencyIds.length === 0) return true;
  const agencyIds = action === "schedule"
    ? planning.scheduleManageAgencyIds
    : action === "assignment"
      ? planning.assignmentManageAgencyIds
      : planning.agencyIds;
  const defaultDate = agencyDate();
  const from = range === undefined ? defaultDate : range.from;
  const to = range === undefined ? defaultDate : range.to;
  const membershipCovers = (memberships: PlanningMembership[], subjectId: string) =>
    memberships.some((membership) => membershipCoversRange(membership, subjectId, { from, to }));
  return planning.agencyRosters.some((roster) =>
    agencyIds.includes(roster.agencyId)
    && subjects.individualIds.length > 0
    && subjects.individualIds.every((id) => membershipCovers(roster.individualMemberships, id))
    && (subjects.employeeId === null || membershipCovers(roster.employeeMemberships, subjects.employeeId)));
}

/** Scope employee-only planner records such as working hours and time off. */
export function planningEmployeeAllowed(
  planning: PlanningAccess,
  employeeId: string,
  action: "read" | "assignment" = "read",
  range?: PlanningDateRange,
): boolean {
  if (planning.agencyIds.length === 0) return true;
  const agencyIds = action === "assignment"
    ? planning.assignmentManageAgencyIds
    : planning.agencyIds;
  const defaultDate = agencyDate();
  const requested = range ?? { from: defaultDate, to: defaultDate };
  return planning.agencyRosters.some((roster) =>
    agencyIds.includes(roster.agencyId)
    && roster.employeeMemberships.some((membership) =>
      membershipCoversRange(membership, employeeId, requested)));
}

function membershipCoversRange(
  membership: PlanningMembership,
  subjectId: string,
  range: PlanningDateRange,
): boolean {
  const startsBeforeRange = range.from === null
    ? membership.effectiveFrom === "-infinity"
    : membership.effectiveFrom === "-infinity" || membership.effectiveFrom <= range.from;
  const endsAfterRange = range.to === null
    ? membership.effectiveTo === null || membership.effectiveTo === "infinity"
    : membership.effectiveTo === null || membership.effectiveTo === "infinity" || membership.effectiveTo >= range.to;
  return membership.subjectId === subjectId && startsBeforeRange && endsAfterRange;
}

/** Candidate employees must share one agency and the whole service range with every participant. */
export function planningEmployeeIdsAllowedForSubjects(
  planning: PlanningAccess,
  individualIds: string[],
  range: PlanningDateRange,
  action: "read" | "schedule" = "read",
): string[] | null {
  if (planning.agencyIds.length === 0) return null;
  const agencyIds = action === "schedule" ? planning.scheduleManageAgencyIds : planning.agencyIds;
  const allowed = new Set<string>();
  for (const roster of planning.agencyRosters) {
    if (!agencyIds.includes(roster.agencyId) || individualIds.length === 0) continue;
    if (!individualIds.every((id) => roster.individualMemberships.some((membership) =>
      membershipCoversRange(membership, id, range)))) continue;
    for (const employeeId of roster.employeeIds) {
      if (roster.employeeMemberships.some((membership) =>
        membershipCoversRange(membership, employeeId, range))) allowed.add(employeeId);
    }
  }
  return [...allowed];
}

function membershipOverlapsRange(
  membership: PlanningMembership,
  subjectId: string,
  range: { from: string; to: string },
): boolean {
  return membership.subjectId === subjectId
    && (membership.effectiveFrom === "-infinity" || membership.effectiveFrom <= range.to)
    && (membership.effectiveTo === null || membership.effectiveTo === "infinity" || membership.effectiveTo >= range.from);
}

function planningSubjectsOverlap(
  planning: PlanningAccess,
  subjects: { individualIds: string[]; employeeId: string | null },
  range: { from: string; to: string },
): boolean {
  return planning.agencyRosters.some((roster) => {
    if (!planning.agencyIds.includes(roster.agencyId) || subjects.individualIds.length === 0) return false;
    const memberships = [
      ...subjects.individualIds.map((subjectId) =>
        roster.individualMemberships.filter((membership) => membershipOverlapsRange(membership, subjectId, range))),
      ...(subjects.employeeId === null ? [] : [
        roster.employeeMemberships.filter((membership) =>
          membershipOverlapsRange(membership, subjects.employeeId!, range)),
      ]),
    ];
    if (memberships.some((entries) => entries.length === 0)) return false;
    let intersections: Array<{ from: string; to: string }> = [{ from: range.from, to: range.to }];
    for (const entries of memberships) {
      intersections = intersections.flatMap((current) => entries.flatMap((membership) => {
        const from = membership.effectiveFrom === "-infinity" || membership.effectiveFrom < current.from
          ? current.from
          : membership.effectiveFrom;
        const membershipTo = membership.effectiveTo === null || membership.effectiveTo === "infinity"
          ? current.to
          : membership.effectiveTo;
        const to = membershipTo > current.to ? current.to : membershipTo;
        return from <= to ? [{ from, to }] : [];
      }));
      if (intersections.length === 0) return false;
    }
    return intersections.length > 0;
  });
}

/** Employee pay targets belong only to the internal planner workflow. */
export function canViewPlannerDirectPayTargets(planning: PlanningAccess): boolean {
  return planning.agencyIds.length === 0;
}

export async function planningSeriesAllowed(
  pool: Pick<ReturnType<typeof getPool>, "query">,
  planning: PlanningAccess,
  seriesId: string,
  action: "read" | "schedule" = "read",
  range?: PlanningDateRange,
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(seriesId)) return false;
  if (planning.agencyIds.length === 0) return true;
  const { rows } = await pool.query<{
    employee_id: string | null; individual_ids: string[]; start_date: string; end_date: string;
  }>(
    `SELECT s.employee_id, s.start_date::text, s.end_date::text,
            ARRAY(SELECT individual_id::text FROM schedule_series_individuals WHERE series_id = s.id) AS individual_ids
       FROM schedule_series s
      LEFT JOIN programs p ON p.id = s.program_id
      WHERE s.id = $1 AND s.archived_at IS NULL
        AND (p.id IS NULL OR (
          p.required_auth_type <> 'dollars'
          AND p.consumption_source IN ('payroll', 'mixed')
        ))`,
    [seriesId],
  );
  if (!rows[0]) return false;
  const subjects = {
    individualIds: rows[0].individual_ids,
    employeeId: rows[0].employee_id,
  };
  if (range) {
    if (range.from === null || range.from > rows[0].end_date) return false;
    const affectedRange = action === "schedule"
      ? { from: range.from, to: rows[0].end_date }
      : range;
    return planningSubjectsAllowed(planning, subjects, action, affectedRange);
  }
  if (action === "schedule") {
    const today = agencyDate();
    if (today > rows[0].end_date) return false;
    return planningSubjectsAllowed(planning, subjects, action, {
      from: rows[0].start_date > today ? rows[0].start_date : today,
      to: rows[0].end_date,
    });
  }
  return planningSubjectsOverlap(planning, subjects, {
    from: rows[0].start_date,
    to: rows[0].end_date,
  });
}

export async function planningProgramAllowed(
  pool: Pick<ReturnType<typeof getPool>, "query">,
  planning: PlanningAccess,
  programId: string | null | undefined,
  options: { allowInactive?: boolean } = {},
): Promise<boolean> {
  if (programId === null || programId === undefined || programId === "") return true;
  if (!/^[0-9a-f-]{36}$/i.test(programId)) return false;
  if (planning.agencyIds.length === 0) return true;
  const { rows } = await pool.query<{ allowed: boolean }>(
    `SELECT true AS allowed FROM programs
      WHERE id = $1 AND ($2::boolean IS TRUE OR is_active = true)
        AND required_auth_type <> 'dollars'
        AND consumption_source IN ('payroll', 'mixed')`,
    [programId, options.allowInactive ?? false],
  );
  return rows[0]?.allowed === true;
}

/**
 * Resolve API access for Planning without granting the broader manager role.
 * Database failures fail closed so schedule endpoints never fall back to role-
 * only access for a restricted account.
 */
export async function apiPlanningUser(): Promise<PlanningAccess | null> {
  const user = await apiUser("viewer");
  if (!user) return null;

  try {
    return await resolvePlanningAccess(user);
  } catch {
    return null;
  }
}

/** Page equivalent of apiPlanningUser: signed-out users go to sign-in. */
export async function requirePlanningUser(): Promise<PlanningAccess> {
  const user = await requireUser("viewer");
  const planning = await resolvePlanningAccess(user);
  if (!planning) redirect(`${homePathForRole(user.role)}?denied=1`);
  return planning;
}
