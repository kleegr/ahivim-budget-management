import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  apiUser: vi.fn(),
  requireUser: vi.fn(),
  homePathForRole: vi.fn(() => "/home"),
}));
import { fullAccess, type AccessScope } from "@/lib/auth/access";
import {
  canViewPlannerDirectPayTargets,
  planningEmployeeIdsAllowedForSubjects,
  planningProgramAllowed,
  planningSeriesAllowed,
  planningSubjectsAllowed,
  type PlanningAccess,
} from "@/lib/auth/planning-access";
import { filterPlanningWorkspaceForAgency, getPlanningWorkspace, type PlanningWorkspaceData } from "@/lib/data/planning-queries";
import { getCommandDestinations } from "@/lib/nav/app-navigation";
import { viewerHomePath } from "@/lib/nav/home-route";
import { agencyIdsWithPlanningAccess, type PortalAccessContext } from "@/lib/auth/portal-access";

const AGENCY_A = "00000000-0000-4000-8000-000000000001";
const AGENCY_B = "00000000-0000-4000-8000-000000000002";
const INDIVIDUAL_A = "00000000-0000-4000-8000-000000000003";
const INDIVIDUAL_B = "00000000-0000-4000-8000-000000000004";
const EMPLOYEE_A = "00000000-0000-4000-8000-000000000005";
const EMPLOYEE_B = "00000000-0000-4000-8000-000000000006";

function hoursOnlyScope(): AccessScope {
  return {
    ...fullAccess("00000000-0000-4000-8000-000000000007", "viewer"),
    full: false,
    allIndividuals: false,
    allEmployees: false,
    individualIds: [INDIVIDUAL_A, INDIVIDUAL_B],
    employeeIds: [EMPLOYEE_A, EMPLOYEE_B],
    grantedIndividualIds: [INDIVIDUAL_A, INDIVIDUAL_B],
    grantedEmployeeIds: [EMPLOYEE_A, EMPLOYEE_B],
    canSeeTransactions: false,
    canSeeMoney: false,
    canSeeBilledAmounts: false,
    canSeeEmployeeAmounts: false,
    canSeeAgencySpread: false,
    canSeeCheckNet: false,
    canSeeTaxes: false,
    canSeeEmployeeDeals: false,
    canSeeSettlements: false,
    canManageSettlements: false,
    canSeeClassFinancials: false,
    canManageClassInvoices: false,
    canEditDocuments: false,
  };
}

function planning(): PlanningAccess {
  return {
    user: { id: "00000000-0000-4000-8000-000000000007", email: "planner@example.com", displayName: "Planner", role: "viewer" },
    access: hoursOnlyScope(),
    agencyIds: [AGENCY_A, AGENCY_B],
    agencyRosters: [
      {
        agencyId: AGENCY_A,
        individualIds: [INDIVIDUAL_A],
        employeeIds: [EMPLOYEE_A],
        individualMemberships: [{ subjectId: INDIVIDUAL_A, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }],
        employeeMemberships: [{ subjectId: EMPLOYEE_A, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }],
      },
      {
        agencyId: AGENCY_B,
        individualIds: [INDIVIDUAL_B],
        employeeIds: [EMPLOYEE_B],
        individualMemberships: [{ subjectId: INDIVIDUAL_B, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }],
        employeeMemberships: [{ subjectId: EMPLOYEE_B, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }],
      },
    ],
    scheduleManageAgencyIds: [AGENCY_A, AGENCY_B],
    assignmentManageAgencyIds: [AGENCY_A],
    canManageSchedules: true,
    canManageAssignments: true,
  };
}

describe("agency planning privacy", () => {
  it("requires an employee and every participant to share one permitted agency", () => {
    const access = planning();
    expect(canViewPlannerDirectPayTargets(access)).toBe(false);
    expect(planningSubjectsAllowed(access, { individualIds: [INDIVIDUAL_A], employeeId: EMPLOYEE_A }, "schedule")).toBe(true);
    expect(planningSubjectsAllowed(access, { individualIds: [INDIVIDUAL_A], employeeId: EMPLOYEE_A }, "schedule", {
      from: "2027-01-01",
      to: "2027-01-01",
    })).toBe(false);
    expect(planningSubjectsAllowed(access, { individualIds: [INDIVIDUAL_B], employeeId: EMPLOYEE_A }, "schedule")).toBe(false);
    expect(planningSubjectsAllowed(access, { individualIds: [INDIVIDUAL_B], employeeId: EMPLOYEE_B }, "assignment")).toBe(false);
  });

  it("fails closed for an unbounded assignment start unless every membership has unbounded history", () => {
    const access = planning();
    expect(planningSubjectsAllowed(access, {
      individualIds: [INDIVIDUAL_A],
      employeeId: EMPLOYEE_A,
    }, "assignment", { from: null, to: "2026-12-31" })).toBe(false);

    access.agencyRosters[0]!.individualMemberships[0]!.effectiveFrom = "-infinity";
    access.agencyRosters[0]!.employeeMemberships[0]!.effectiveFrom = "-infinity";
    expect(planningSubjectsAllowed(access, {
      individualIds: [INDIVIDUAL_A],
      employeeId: EMPLOYEE_A,
    }, "assignment", { from: null, to: "2026-12-31" })).toBe(true);
  });

  it("offers availability only from a shared agency covering the requested range", () => {
    expect(planningEmployeeIdsAllowedForSubjects(
      planning(),
      [INDIVIDUAL_A],
      { from: "2026-08-01", to: "2026-08-31" },
    )).toEqual([EMPLOYEE_A]);
    expect(planningEmployeeIdsAllowedForSubjects(
      planning(),
      [INDIVIDUAL_A, INDIVIDUAL_B],
      { from: "2026-08-01", to: "2026-08-31" },
    )).toEqual([]);
  });

  it("allows a mid-series agency handoff and keeps inactive hours programs eligible for cleanup", async () => {
    const access = planning();
    access.agencyRosters[0]!.individualMemberships[0]!.effectiveFrom = "2026-08-01";
    access.agencyRosters[0]!.employeeMemberships[0]!.effectiveFrom = "2026-08-01";
    const calls: Array<[string, unknown[] | undefined]> = [];
    const query = async (sql: string, params?: unknown[]) => {
      calls.push([sql, params]);
      return { rows: [{
        employee_id: EMPLOYEE_A,
        individual_ids: [INDIVIDUAL_A],
        start_date: "2026-01-01",
        end_date: "2026-12-31",
      }] };
    };

    await expect(planningSeriesAllowed({ query } as never, access, AGENCY_A, "read")).resolves.toBe(true);
    expect(calls[0]![0]).not.toContain("p.is_active = true");
    await expect(planningSeriesAllowed(
      { query } as never,
      access,
      AGENCY_A,
      "schedule",
      { from: "2026-08-01", to: "2026-10-31" },
    )).resolves.toBe(true);
  });

  it("removes cross-agency session, series, and assignment pairings from read models", () => {
    const data = {
      workQueue: [
        { id: "same", sessionDate: "2026-08-28", individualIds: [INDIVIDUAL_A], employeeId: EMPLOYEE_A, reasonCodes: ["conflict"] },
        { id: "cross", sessionDate: "2026-08-28", individualIds: [INDIVIDUAL_B], employeeId: EMPLOYEE_A, reasonCodes: ["over_budget"] },
      ],
      workQueueTotal: 2,
      series: [
        { id: "same", startDate: "2026-08-28", endDate: "2026-09-30", participantIds: [INDIVIDUAL_A], employeeId: EMPLOYEE_A, issueCodes: [] },
        { id: "cross", startDate: "2026-08-28", endDate: "2026-09-30", participantIds: [INDIVIDUAL_B], employeeId: EMPLOYEE_A, issueCodes: [] },
      ],
      assignments: [
        { id: "same", startDate: "2026-08-28", endDate: "2026-09-30", individualId: INDIVIDUAL_A, employeeId: EMPLOYEE_A },
        { id: "cross", startDate: "2026-08-28", endDate: "2026-09-30", individualId: INDIVIDUAL_B, employeeId: EMPLOYEE_A },
      ],
      coverage: [],
      authorizationGaps: [],
      nextSevenDaySessions: [
        { sessionDate: "2026-08-28", employeeId: EMPLOYEE_A, individualIds: [INDIVIDUAL_A], hours: "2.0000" },
        { sessionDate: "2026-08-28", employeeId: EMPLOYEE_A, individualIds: [INDIVIDUAL_B], hours: "9.0000" },
      ],
      summary: {
        activeSchedules: 2,
        scheduledNextSevenDaysHours: "11.0000",
        unassignedSessions: 0,
        conflictedSessions: 1,
        overBudgetSessions: 0,
      },
      asOf: "2026-08-28",
    } as unknown as PlanningWorkspaceData;
    const scoped = filterPlanningWorkspaceForAgency(data, planning().agencyRosters);

    expect(scoped.workQueue.map((row) => row.id)).toEqual(["same"]);
    expect(scoped.series.map((row) => row.id)).toEqual(["same"]);
    expect(scoped.assignments.map((row) => row.id)).toEqual(["same"]);
    expect(scoped.summary.scheduledNextSevenDaysHours).toBe("2.0000");
    expect(scoped.summary.conflictedSessions).toBe(1);
    expect(scoped.summary.overBudgetSessions).toBe(0);
  });

  it("clips a handed-off series to the shared membership interval and hides unbounded assignments", () => {
    const access = planning();
    access.agencyRosters[0]!.individualMemberships[0]!.effectiveFrom = "2026-08-01";
    access.agencyRosters[0]!.employeeMemberships[0]!.effectiveFrom = "2026-08-01";
    const data = {
      asOf: "2026-08-28",
      workQueue: [],
      workQueueTotal: 0,
      coverage: [],
      authorizationGaps: [],
      nextSevenDaySessions: [],
      series: [{
        id: "handoff",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
        participantIds: [INDIVIDUAL_A],
        employeeId: EMPLOYEE_A,
        issueCodes: [],
      }],
      assignments: [{
        id: "unbounded",
        startDate: null,
        endDate: "2026-12-31",
        individualId: INDIVIDUAL_A,
        employeeId: EMPLOYEE_A,
      }],
      summary: {
        activeSchedules: 1,
        scheduledNextSevenDaysHours: "0.0000",
        unassignedSessions: 0,
        conflictedSessions: 0,
        overBudgetSessions: 0,
        coverageGaps: 0,
        futurePlanGaps: 0,
      },
    } as unknown as PlanningWorkspaceData;

    const scoped = filterPlanningWorkspaceForAgency(data, access.agencyRosters);
    expect(scoped.series).toHaveLength(1);
    expect(scoped.series[0]).toMatchObject({ startDate: "2026-08-01", endDate: "2026-12-31" });
    expect(scoped.assignments).toEqual([]);
  });

  it("routes an agency scheduler to Planning without money, Budgets, or Employees navigation", () => {
    const portal: PortalAccessContext = {
      userId: planning().user.id,
      globalRoles: [],
      agencyAccess: [{
        agencyId: AGENCY_A,
        agencyCode: "A",
        agencyName: "Agency A",
        role: "scheduler",
        grants: [],
        denials: [],
      }],
      individualLinks: [],
      employeeLinks: [],
    };
    expect(viewerHomePath(hoursOnlyScope(), portal)).toBe("/schedule");
    const hrefs = getCommandDestinations({
      role: "viewer",
      accessResolved: true,
      canSeeTransactions: false,
      canSeeSettlements: false,
      canSeeBudgets: false,
      canPlan: true,
      canSeeEmployees: false,
      canEditDocuments: false,
      canUsePortal: true,
    }).map((item) => item.href);
    expect(hrefs).toContain("/schedule");
    expect(hrefs).not.toContain("/transactions");
    expect(hrefs).not.toContain("/individuals");
    expect(hrefs).not.toContain("/employees");
  });

  it("honors an hour-budget denial and validates the hours-only program catalog", async () => {
    const deniedPortal: PortalAccessContext = {
      userId: planning().user.id,
      globalRoles: [],
      agencyAccess: [{
        agencyId: AGENCY_A,
        agencyCode: "A",
        agencyName: "Agency A",
        role: "scheduler",
        grants: [],
        denials: ["hours_budgets.agency.read"],
      }],
      individualLinks: [],
      employeeLinks: [],
    };
    expect(agencyIdsWithPlanningAccess(deniedPortal)).toEqual([]);

    const query = async () => ({ rows: [] });
    await expect(planningProgramAllowed({ query } as never, planning(), INDIVIDUAL_A)).resolves.toBe(false);
  });

  it("filters assignment coverage at SQL time before authorization gaps are classified", async () => {
    const calls: string[] = [];
    const query = async (sql: string) => {
      calls.push(sql);
      return { rows: [] };
    };
    await getPlanningWorkspace(
      { query } as never,
      "2026-08-28",
      hoursOnlyScope(),
      [AGENCY_A, AGENCY_B],
    );

    const gapSql = calls.find((sql) => sql.includes("has_coverage_gap"));
    expect(gapSql).toContain("scoped_assignments AS");
    expect(gapSql).toContain("JOIN agency_employees ae ON ae.agency_id = ai.agency_id");
    expect(gapSql).toContain("COALESCE(a.start_date, '-infinity'::date)");
    expect(gapSql).toContain("FROM scoped_assignments a");

    const coverageSql = calls.find((sql) => sql.includes("WITH current_auth AS"));
    expect(coverageSql).toContain("ea.source_candidate_count");
    expect(coverageSql).toContain("ca.source_candidate_count");
  });
});
