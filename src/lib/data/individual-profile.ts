import type { AccessScope } from "@/lib/auth/access";
import { agencyDate } from "@/lib/business/agency-time";
import { listSessions, type CalendarSession } from "@/lib/data/schedule-queries";
import type { PgLikePool } from "@/lib/import/commit";
import { listAssignments } from "@/lib/manage/assignments";
import { dec } from "@/lib/money";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface IndividualAgencyResponsibility {
  agencyId: string;
  agencyCode: string;
  agencyName: string;
  managesBudget: boolean;
  billsServices: boolean;
}

export interface IndividualPortalPreviewAccount {
  userId: string;
  displayName: string;
  email: string;
  relationship: "self" | "parent" | "guardian" | "representative";
}

export interface IndividualProfileContext {
  agencies: IndividualAgencyResponsibility[];
  upcomingSessions: CalendarSession[];
  previewAccounts: IndividualPortalPreviewAccount[];
}

export interface IndividualPortfolioStaffingContext {
  assignedEmployees: Array<{ id: string; name: string }>;
  nextSession: CalendarSession | null;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function assignmentIsCurrent(
  assignment: { startDate: string | null; endDate: string | null },
  asOf: string,
): boolean {
  return (!assignment.startDate || assignment.startDate <= asOf)
    && (!assignment.endDate || assignment.endDate >= asOf);
}

/**
 * Profile headline data for the already-filtered active calculation setups.
 * The Masser statement is the authoritative current aggregate when available;
 * otherwise, fall back to an exact Decimal sum of each approved final.
 */
export function summarizeActiveFinancialSetups(
  strategies: Array<{ label: string; afterAll: string | null }>,
  authoritativeApprovedMonthly?: string | null,
): { labels: string[]; approvedMonthly: string | null } {
  const approved = strategies.filter(
    (strategy): strategy is { label: string; afterAll: string } => strategy.afterAll !== null,
  );
  return {
    labels: strategies.map((strategy) => strategy.label),
    approvedMonthly: authoritativeApprovedMonthly !== undefined && authoritativeApprovedMonthly !== null
      ? dec(authoritativeApprovedMonthly).toFixed(4)
      : approved.length > 0
        ? approved.reduce((total, strategy) => total.plus(strategy.afterAll), dec(0)).toFixed(4)
        : null,
  };
}

/**
 * Current staffing and the next planned visit for the all-individual portfolio.
 *
 * This deliberately composes the canonical assignment and schedule readers
 * instead of introducing another definition of either fact. The caller must
 * explicitly opt into planning visibility; restricted profiles then perform no
 * employee or schedule query at all.
 */
export async function getIndividualPortfolioStaffingContext(
  pool: PgLikePool,
  scope: AccessScope,
  options: { canViewPlanning: boolean; from?: string; throughDays?: number },
): Promise<Map<string, IndividualPortfolioStaffingContext>> {
  if (!options.canViewPlanning) return new Map();

  const from = options.from ?? agencyDate();
  const through = addDays(from, options.throughDays ?? 366);
  const [assignments, sessions] = await Promise.all([
    listAssignments(pool, { scope, hoursOnlyPrograms: true }),
    listSessions(pool, { from, to: through, status: "pending" }, scope),
  ]);
  const context = new Map<string, IndividualPortfolioStaffingContext>();
  const ensure = (individualId: string) => {
    let value = context.get(individualId);
    if (!value) {
      value = { assignedEmployees: [], nextSession: null };
      context.set(individualId, value);
    }
    return value;
  };

  for (const assignment of assignments) {
    if (!assignmentIsCurrent(assignment, from)) continue;
    const value = ensure(assignment.individualId);
    if (!value.assignedEmployees.some((employee) => employee.id === assignment.employeeId)) {
      value.assignedEmployees.push({ id: assignment.employeeId, name: assignment.employeeName });
    }
  }
  for (const value of context.values()) {
    value.assignedEmployees.sort((left, right) => left.name.localeCompare(right.name));
  }

  // listSessions is date/time ordered. The first occurrence for each participant
  // is therefore the exact next planned service for that individual.
  for (const session of sessions) {
    for (const individualId of session.individualIds) {
      const value = ensure(individualId);
      if (!value.nextSession) value.nextSession = session;
    }
  }

  return context;
}

/** Profile-only context that is not part of the financial authorization read model. */
export async function getIndividualProfileContext(
  pool: PgLikePool,
  individualId: string,
  scope: AccessScope,
  options: { canPreviewPortal: boolean; canViewSchedule: boolean; from?: string } = {
    canPreviewPortal: false,
    canViewSchedule: false,
  },
): Promise<IndividualProfileContext> {
  if (!UUID.test(individualId)) {
    return { agencies: [], upcomingSessions: [], previewAccounts: [] };
  }
  const from = options.from ?? agencyDate();
  const through = addDays(from, 60);
  const [agencyResult, upcomingSessions, previewResult] = await Promise.all([
    pool.query<{
      agency_id: string;
      agency_code: string;
      agency_name: string;
      manages_budget: boolean;
      bills_services: boolean;
    }>(
      `SELECT agency.id AS agency_id, agency.code AS agency_code, agency.name AS agency_name,
              membership.manages_budget, membership.bills_services
         FROM agency_individuals membership
         JOIN agencies agency ON agency.id = membership.agency_id
        WHERE membership.individual_id = $1
          AND membership.is_active = true
          AND membership.effective_from <= $2::date
          AND (membership.effective_to IS NULL OR membership.effective_to >= $2::date)
          AND agency.status = 'active'
        ORDER BY membership.manages_budget DESC, membership.bills_services DESC, agency.name`,
      [individualId, from],
    ),
    options.canViewSchedule
      ? listSessions(pool, {
          from,
          to: through,
          individualId,
          status: "pending",
        }, scope)
      : Promise.resolve([]),
    options.canPreviewPortal
      ? pool.query<{
          user_id: string;
          display_name: string;
          email: string;
          relationship_type: IndividualPortalPreviewAccount["relationship"];
        }>(
          `SELECT DISTINCT ON (relationship.user_id)
                  relationship.user_id, account.display_name, account.email,
                  relationship.relationship_type
             FROM user_individual_relationships relationship
             JOIN users account ON account.id = relationship.user_id
            WHERE relationship.individual_id = $1
              AND relationship.is_active = true
              AND account.is_active = true
              AND EXISTS (
                SELECT 1
                  FROM user_portal_roles portal_role
                 WHERE portal_role.user_id = relationship.user_id
                   AND portal_role.is_active = true
                   AND portal_role.portal_role = CASE
                     WHEN relationship.relationship_type = 'self' THEN 'individual'
                     ELSE 'parent'
                   END
              )
            ORDER BY relationship.user_id,
                     CASE relationship.relationship_type
                       WHEN 'self' THEN 0 WHEN 'parent' THEN 1
                       WHEN 'guardian' THEN 2 ELSE 3
                     END`,
          [individualId],
        )
      : Promise.resolve({ rows: [] }),
  ]);

  return {
    agencies: agencyResult.rows.map((row) => ({
      agencyId: row.agency_id,
      agencyCode: row.agency_code,
      agencyName: row.agency_name,
      managesBudget: row.manages_budget,
      billsServices: row.bills_services,
    })),
    upcomingSessions,
    previewAccounts: previewResult.rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      email: row.email,
      relationship: row.relationship_type,
    })),
  };
}

export interface IndividualProfileAction {
  label: string;
  detail: string;
  href: string;
  tone: "warning" | "danger" | "neutral";
}

/** Pick one useful next step instead of presenting a wall of competing actions. */
export function individualProfileMainAction(input: {
  individualId: string;
  status: string;
  canManage: boolean;
  canViewBudget: boolean;
  canPlan: boolean;
  hasBudget: boolean;
  missingRenewal: boolean;
  hoursAfterScheduled: string | number | null;
  assignmentCount: number;
  remainingReserve: string | null;
}): IndividualProfileAction {
  const profile = `/individuals/${input.individualId}`;
  if (input.status !== "active") {
    return {
      label: "Review profile status",
      detail: `This person is ${input.status}.`,
      href: `${profile}?view=more`,
      tone: "warning",
    };
  }
  if (!input.canViewBudget) {
    return {
      label: input.assignmentCount === 0 ? "Review staffing" : "Review activity",
      detail: input.assignmentCount === 0
        ? "No active employee assignment is visible on this profile."
        : "Budget details are restricted for this account.",
      href: `${profile}?view=activity`,
      tone: input.assignmentCount === 0 ? "warning" : "neutral",
    };
  }
  if (!input.hasBudget) {
    return {
      label: input.canManage ? "Set up budget" : "Budget needs setup",
      detail: "No active hourly authorization is configured.",
      href: `${profile}?view=budget`,
      tone: "warning",
    };
  }
  if (input.missingRenewal) {
    return {
      label: input.canManage ? "Add renewal date" : "Renewal date needed",
      detail: "At least one active authorization has no renewal date.",
      href: `${profile}?view=budget`,
      tone: "warning",
    };
  }
  if (input.hoursAfterScheduled !== null && dec(input.hoursAfterScheduled).isNegative()) {
    return {
      label: input.canPlan ? "Adjust schedule" : "Review budget",
      detail: "Planned visits exceed the remaining authorization.",
      href: input.canPlan
        ? `/schedule?view=calendar&individualId=${input.individualId}`
        : `${profile}?view=budget`,
      tone: "danger",
    };
  }
  if (input.assignmentCount === 0) {
    return {
      label: input.canPlan ? "Assign an employee" : "Review staffing",
      detail: "No active employee assignment is on file.",
      href: input.canPlan
        ? `/schedule?view=future&individualId=${input.individualId}`
        : `${profile}?view=activity`,
      tone: "warning",
    };
  }
  if (input.remainingReserve !== null && dec(input.remainingReserve).greaterThan(0)) {
    return {
      label: "Record put-away",
      detail: "Approved reserve is still outstanding.",
      href: `/masser/individuals/${input.individualId}`,
      tone: "warning",
    };
  }
  return {
    label: "Review activity",
    detail: "No urgent profile exception is open.",
    href: `${profile}?view=activity`,
    tone: "neutral",
  };
}
