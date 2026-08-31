import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { AccessScope } from "@/lib/auth/access";
import { planningEmployeeProfile } from "@/lib/auth/employee-planning-access";
import { listPlanningEmployeeDirectory } from "@/lib/data/employee-directory";
import type { PgLikePool } from "@/lib/import/commit";

const EMPLOYEE_ID = "00000000-0000-4000-8000-000000000001";

const mocks = vi.hoisted(() => ({
  apiUser: vi.fn(),
  getPool: vi.fn(),
  resolveAccessScope: vi.fn(),
  listEmployeesManaged: vi.fn(),
  getEmployee: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.apiUser }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/auth/access", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/auth/access")>(),
  resolveAccessScope: mocks.resolveAccessScope,
}));
vi.mock("@/lib/manage/employees", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/manage/employees")>(),
  listEmployeesManaged: mocks.listEmployeesManaged,
  getEmployee: mocks.getEmployee,
}));

import { GET as listEmployees } from "@/app/api/employees/route";
import { GET as getEmployee } from "@/app/api/employees/[id]/route";

function planningScope(overrides: Partial<AccessScope> = {}): AccessScope {
  return {
    userId: "planner",
    role: "viewer",
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
    allIndividuals: true,
    allEmployees: true,
    individualIds: [],
    employeeIds: [],
    grantedIndividualIds: [],
    grantedEmployeeIds: [],
    ...overrides,
  };
}

function employeeRecord() {
  return {
    id: EMPLOYEE_ID,
    displayName: "Employee One",
    normalizedName: "employee one",
    externalRef: "PAYROLL-99",
    status: "active",
    notes: "Private pay arrangement",
    payoutCutPercent: "0.25",
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("finance-free planning employee read model", () => {
  it("queries only staffing, scheduling, and availability data", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: [{
        id: EMPLOYEE_ID,
        display_name: "Employee One",
        status: "active",
        archived_at: null,
        active_assignments: "2",
        assigned_individuals: "2",
        pending_sessions: "3",
        pending_hours: "6.5",
        next_session_date: "2026-09-02",
        weekly_availability_windows: "4",
        upcoming_time_off: "1",
      }],
      sql,
    }));
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    const rows = await listPlanningEmployeeDirectory(pool, planningScope());
    expect(rows).toEqual([{
      id: EMPLOYEE_ID,
      displayName: "Employee One",
      status: "active",
      archivedAt: null,
      activeAssignments: 2,
      assignedIndividuals: 2,
      pendingSessions: 3,
      pendingHours: "6.5000",
      nextSessionDate: "2026-09-02",
      weeklyAvailabilityWindows: 4,
      upcomingTimeOff: 1,
    }]);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("FROM assignments");
    expect(sql).toContain("FROM scheduled_sessions");
    expect(sql).toContain("FROM employee_weekly_availability");
    expect(sql).not.toMatch(/payroll|check|amount|rate|tax|deal|settlement|external_ref|notes|payout/i);
  });

  it("fails closed when the caller lacks full-roster planning access", async () => {
    const query = vi.fn();
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;
    await expect(listPlanningEmployeeDirectory(
      pool,
      planningScope({ allEmployees: false }),
    )).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("reduces an employee profile to operational identity fields", () => {
    expect(planningEmployeeProfile(employeeRecord())).toEqual({
      id: EMPLOYEE_ID,
      displayName: "Employee One",
      status: "active",
      archivedAt: null,
    });
  });
});

describe("planning employee API privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiUser.mockResolvedValue({ id: "planner", role: "viewer" });
    mocks.getPool.mockReturnValue({ query: vi.fn() });
    mocks.resolveAccessScope.mockResolvedValue(planningScope());
    mocks.listEmployeesManaged.mockResolvedValue([employeeRecord()]);
    mocks.getEmployee.mockResolvedValue(employeeRecord());
  });

  it("redacts payroll reference, notes, deals, and every incidental field from the list API", async () => {
    const response = await listEmployees(new NextRequest("http://localhost/api/employees"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([{
      id: EMPLOYEE_ID,
      displayName: "Employee One",
      status: "active",
      archivedAt: null,
    }]);
    expect(JSON.stringify(body)).not.toMatch(/PAYROLL-99|Private pay|payoutCutPercent|normalizedName|createdAt/);
  });

  it("applies the same exact redaction to an employee detail API response", async () => {
    const response = await getEmployee(
      new NextRequest(`http://localhost/api/employees/${EMPLOYEE_ID}`),
      { params: Promise.resolve({ id: EMPLOYEE_ID }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      id: EMPLOYEE_ID,
      displayName: "Employee One",
      status: "active",
      archivedAt: null,
    });
  });
});
