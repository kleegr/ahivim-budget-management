import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalAccessContext } from "@/lib/auth/portal-access";
import type { PortalAgencySummary } from "@/lib/data/portal-read-model";
import type { PlanningWorkspaceData } from "@/lib/data/planning-queries";
import type { PgLikePool } from "@/lib/import/commit";

const mocks = vi.hoisted(() => ({
  getPortalHomeReadModel: vi.fn(),
  getPlanningWorkspace: vi.fn(),
  filterPlanningWorkspaceForAgency: vi.fn((data) => data),
  listAgencyIndividualMemberships: vi.fn(),
  listAgencyEmployeeMemberships: vi.fn(),
  listAgencyUserAccess: vi.fn(),
}));

vi.mock("@/lib/data/portal-read-model", () => ({
  getPortalHomeReadModel: mocks.getPortalHomeReadModel,
}));
vi.mock("@/lib/data/planning-queries", () => ({
  getPlanningWorkspace: mocks.getPlanningWorkspace,
  filterPlanningWorkspaceForAgency: mocks.filterPlanningWorkspaceForAgency,
}));
vi.mock("@/lib/manage/agencies", () => ({
  listAgencyIndividualMemberships: mocks.listAgencyIndividualMemberships,
  listAgencyEmployeeMemberships: mocks.listAgencyEmployeeMemberships,
  listAgencyUserAccess: mocks.listAgencyUserAccess,
}));

import { getAgencyProfileReadModel } from "@/lib/data/agency-profile";

const AGENCY = "00000000-0000-4000-8000-000000000001";
const OTHER_AGENCY = "00000000-0000-4000-8000-000000000002";
const INDIVIDUAL = "00000000-0000-4000-8000-000000000003";
const EMPLOYEE = "00000000-0000-4000-8000-000000000004";
const pool = {} as PgLikePool;

function agency(): PortalAgencySummary {
  return {
    id: AGENCY,
    code: "A1",
    name: "Agency One",
    roles: [{ key: "owner", label: "Owner" }],
    capabilities: ["agencies.read", "people.agency.read"],
    individualCount: 1,
    employeeCount: 1,
    managedBudgetCount: 0,
    billingWithoutBudgetCount: 0,
    budgetHours: null,
    budgetDollars: null,
    month: "2026-09",
    billedThisMonth: "100.0000",
    setAsideThisMonth: "10.0000",
    agencyPaidThisMonth: "40.0000",
    payrollGrossThisMonth: "50.0000",
    payrollNetThisMonth: "45.0000",
    giveBackRemaining: "5.0000",
    individuals: [],
    employees: [],
  };
}

const individualRoster = [{
  membershipId: "00000000-0000-4000-8000-000000000011",
  individualId: INDIVIDUAL,
  individualName: "Roster Person",
  managesBudget: false,
  billsServices: false,
  isActive: true,
  currentlyEffective: true,
  intervalStatus: "current" as const,
  isLatest: true,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
}];

const employeeRoster = [{
  membershipId: "00000000-0000-4000-8000-000000000012",
  employeeId: EMPLOYEE,
  employeeName: "Roster Employee",
  isActive: true,
  currentlyEffective: true,
  intervalStatus: "current" as const,
  isLatest: true,
  effectiveFrom: "2026-02-01",
  effectiveTo: null,
}];

function planning(): PlanningWorkspaceData {
  return {
    asOf: "2026-09-04",
    workQueue: [],
    workQueueTotal: 0,
    coverage: [{
      authorizationId: "auth",
      individualId: INDIVIDUAL,
      individualName: "Roster Person",
      programId: "program",
      programCode: "COMHAB",
      programName: "Community Habilitation",
      periodLabel: "2026",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      authorizedHours: "100.0000",
      actualHours: "20.0000",
      scheduledHours: "30.0000",
      unplannedHours: "50.0000",
      requiredWeeklyHours: null,
      targetToDateHours: "67.0000",
      paceGapHours: "47.0000",
      usagePercent: "0.2000",
      committedPercent: "0.5000",
      timeElapsedPercent: "0.6700",
      status: "plan_gap",
      eligibleEmployeeCount: 1,
      eligibleEmployeeIds: [EMPLOYEE],
      nextScheduledDate: "2026-09-05",
      sourceCandidateCount: 1,
      sourceAmbiguous: false,
    }],
    series: [],
    authorizationGaps: [],
    assignments: [],
    nextSevenDaySessions: [],
    summary: {
      activeSchedules: 0,
      scheduledNextSevenDaysHours: "0.0000",
      unassignedSessions: 0,
      conflictedSessions: 0,
      overBudgetSessions: 0,
      coverageGaps: 1,
      futurePlanGaps: 0,
    },
  };
}

function ownerContext(): PortalAccessContext {
  return {
    userId: "owner-user",
    globalRoles: [{ role: "owner", grants: [], denials: [] }],
    agencyAccess: [],
    individualLinks: [],
    employeeLinks: [],
  };
}

function agencyContext(denials: PortalAccessContext["agencyAccess"][number]["denials"] = []): PortalAccessContext {
  return {
    userId: "agency-user",
    globalRoles: [],
    agencyAccess: [{
      agencyId: AGENCY,
      agencyCode: "A1",
      agencyName: "Agency One",
      role: "agency",
      grants: [],
      denials,
    }],
    individualLinks: [],
    employeeLinks: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPortalHomeReadModel.mockResolvedValue({ agencies: [agency()] });
  mocks.listAgencyIndividualMemberships.mockResolvedValue(individualRoster);
  mocks.listAgencyEmployeeMemberships.mockResolvedValue(employeeRoster);
  mocks.getPlanningWorkspace.mockResolvedValue(planning());
  mocks.filterPlanningWorkspaceForAgency.mockImplementation((data) => data);
  mocks.listAgencyUserAccess.mockResolvedValue([
    { userId: "owner-user", displayName: "Owner", email: "owner@example.com", role: "agency", isActive: true, capabilityGrants: [], capabilityDenials: [], updatedAt: "now" },
    { userId: "agency-user-2", displayName: "Agency User", email: "agency@example.com", role: "agency", isActive: true, capabilityGrants: [], capabilityDenials: [], updatedAt: "now" },
    { userId: "inactive", displayName: "Inactive", email: "inactive@example.com", role: "collector", isActive: false, capabilityGrants: [], capabilityDenials: [], updatedAt: "now" },
  ]);
});

describe("agency 360 read model", () => {
  it("composes owner financials, full dated rosters, exact planning, and linked account preview", async () => {
    const result = await getAgencyProfileReadModel(pool, ownerContext(), AGENCY, "2026-09", "2026-09-04");

    expect(result?.agency.id).toBe(AGENCY);
    expect(result?.individualRoster?.[0]).toMatchObject({ managesBudget: false, billsServices: false });
    expect(result?.planning?.coverage).toHaveLength(1);
    expect(result?.linkedUsers).toHaveLength(3);
    expect(result?.previewAccounts).toEqual([expect.objectContaining({ userId: "agency-user-2" })]);
    expect(mocks.getPortalHomeReadModel).toHaveBeenCalledWith(pool, expect.anything(), "2026-09", { agencyIds: [AGENCY] });
    expect(mocks.getPlanningWorkspace).toHaveBeenCalledWith(pool, "2026-09-04", undefined, [AGENCY]);
    expect(mocks.filterPlanningWorkspaceForAgency).toHaveBeenCalledWith(expect.anything(), [{
      agencyId: AGENCY,
      individualIds: [INDIVIDUAL],
      employeeIds: [EMPLOYEE],
      individualMemberships: [{ subjectId: INDIVIDUAL, effectiveFrom: "2026-01-01", effectiveTo: null }],
      employeeMemberships: [{ subjectId: EMPLOYEE, effectiveFrom: "2026-02-01", effectiveTo: null }],
    }]);
  });

  it("shows an agency account only the planning and roster fields its capabilities allow", async () => {
    const result = await getAgencyProfileReadModel(pool, agencyContext(), AGENCY, "2026-09", "2026-09-04");

    expect(result?.permissions).toMatchObject({
      isOwner: false,
      canReadPeople: true,
      canReadHours: true,
      canReadSchedules: false,
      canReadAssignments: false,
    });
    expect(result?.planning).toMatchObject({
      coverage: expect.any(Array),
      authorizationGaps: expect.any(Array),
      workQueue: null,
      assignments: null,
      series: null,
      summary: null,
    });
    expect(result?.linkedUsers).toBeNull();
    expect(result?.previewAccounts).toEqual([]);
    expect(mocks.listAgencyUserAccess).not.toHaveBeenCalled();
  });

  it("fails closed outside an assigned agency and skips all data loaders", async () => {
    const result = await getAgencyProfileReadModel(pool, agencyContext(), OTHER_AGENCY);

    expect(result).toBeNull();
    expect(mocks.getPortalHomeReadModel).not.toHaveBeenCalled();
    expect(mocks.listAgencyIndividualMemberships).not.toHaveBeenCalled();
    expect(mocks.getPlanningWorkspace).not.toHaveBeenCalled();
  });

  it("does not load people or planning when the agency people capability is denied", async () => {
    const result = await getAgencyProfileReadModel(pool, agencyContext(["people.agency.read"]), AGENCY);

    expect(result?.individualRoster).toBeNull();
    expect(result?.employeeRoster).toBeNull();
    expect(result?.planning).toBeNull();
    expect(mocks.listAgencyIndividualMemberships).not.toHaveBeenCalled();
    expect(mocks.getPlanningWorkspace).not.toHaveBeenCalled();
  });
});
