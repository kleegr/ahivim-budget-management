import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ pool: { query: vi.fn() }, user: vi.fn(), access: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: () => mocks.pool }));
vi.mock("@/lib/auth/session", () => ({ apiUser: mocks.user, requireUser: mocks.user, homePathForRole: () => "/home" }));
vi.mock("@/lib/auth/access", async original => ({ ...await original<typeof import("@/lib/auth/access")>(), resolveAccessScope: mocks.access }));
import { fullAccess } from "@/lib/auth/access";
import { apiPlanningUser } from "@/lib/auth/planning-access";
import { GET } from "@/app/api/schedule/utilization/route";

const agency = "00000000-0000-4000-8000-000000000001";
const person = "00000000-0000-4000-8000-000000000002";
let role = "staffing_manager";
let grants: string[] = [];
let denials: string[] = [];
beforeEach(() => {
  role = "staffing_manager"; grants = []; denials = [];
  mocks.pool.query.mockReset();
  mocks.user.mockResolvedValue({ id: "agency-user", actorId: "agency-user", role: "viewer", accountPreset: null });
  mocks.access.mockResolvedValue({ ...fullAccess("agency-user", "viewer"), full: false, canPlan: false, allIndividuals: false, allEmployees: false });
  mocks.pool.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM user_agency_access")) return { rows: [{ agency_id: agency, agency_code: "A", agency_name: "Agency", portal_role: role, capability_grants: grants, capability_denials: denials }] };
    if (sql.includes("FROM agency_individuals")) return { rows: [{ agency_id: agency, subject_id: person, effective_from: "2020-01-01", effective_to: null }] };
    return { rows: [] };
  });
});

describe("agency planning role resolution", () => {
  it("keeps staffing assignments and calendars while denying authorization utilization", async () => {
    expect(await apiPlanningUser()).toMatchObject({ agencyIds: [agency], canManageSchedules: true, canManageAssignments: true,
      access: { canSeeBudgets: false, canSeeHours: true, canSeeMoney: false, canSeeClassFinancials: false } });
    expect((await GET(new NextRequest(`http://localhost/api/schedule/utilization?individualId=${person}`))).status).toBe(403);
    expect(mocks.pool.query.mock.calls.some(([sql]) => String(sql).includes("effective_budget_authorizations"))).toBe(false);
  });
  it("preserves scheduler authorization hours and denies assignment management", async () => {
    role = "scheduler";
    expect(await apiPlanningUser()).toMatchObject({ agencyIds: [agency], canManageSchedules: true, canManageAssignments: false,
      access: { canSeeBudgets: true, canSeeMoney: false } });
  });
  it("honors a staffing hours grant, and a denial wins without taking away scheduling", async () => {
    grants = ["hours_budgets.agency.read", "financials.agency.billed_totals.read"];
    expect(await apiPlanningUser()).toMatchObject({ access: { canSeeBudgets: true, canSeeMoney: false } });
    denials = ["hours_budgets.agency.read"];
    expect(await apiPlanningUser()).toMatchObject({ canManageSchedules: true, canManageAssignments: true, access: { canSeeBudgets: false } });
  });
  it("preserves a scheduler's calendar after an hours denial, and respects schedule-read denial", async () => {
    role = "scheduler"; denials = ["hours_budgets.agency.read"];
    expect(await apiPlanningUser()).toMatchObject({ canManageSchedules: true, access: { canSeeBudgets: false } });
    denials.push("schedules.agency.read");
    expect(await apiPlanningUser()).toBeNull();
  });
});
