import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apiPortalUser: vi.fn(),
  createAgency: vi.fn(),
  listAgencies: vi.fn(),
  setAgencyUserAccess: vi.fn(),
  setAgencyIndividualMembership: vi.fn(),
  setAgencyEmployeeMembership: vi.fn(),
  setGlobalPortalRoleAssignment: vi.fn(),
  setIndividualPortalAssignment: vi.fn(),
  setEmployeePortalAssignment: vi.fn(),
  getPortalHomeReadModel: vi.fn(),
}));

vi.mock("@/lib/auth/portal-api", () => ({ apiPortalUser: mocks.apiPortalUser }));
vi.mock("@/lib/manage/agencies", () => ({
  createAgency: mocks.createAgency,
  listAgencies: mocks.listAgencies,
  listAgencyUserAccess: vi.fn(),
  setAgencyUserAccess: mocks.setAgencyUserAccess,
  listAgencyIndividualMemberships: vi.fn(),
  setAgencyIndividualMembership: mocks.setAgencyIndividualMembership,
  listAgencyEmployeeMemberships: vi.fn(),
  setAgencyEmployeeMembership: mocks.setAgencyEmployeeMembership,
}));
vi.mock("@/lib/manage/portal-identities", () => ({
  listGlobalPortalRoleAssignments: vi.fn(),
  setGlobalPortalRoleAssignment: mocks.setGlobalPortalRoleAssignment,
  listIndividualPortalAssignments: vi.fn(),
  listEmployeePortalAssignments: vi.fn(),
  setIndividualPortalAssignment: mocks.setIndividualPortalAssignment,
  setEmployeePortalAssignment: mocks.setEmployeePortalAssignment,
}));
vi.mock("@/lib/data/portal-read-model", () => ({
  getPortalHomeReadModel: mocks.getPortalHomeReadModel,
}));

import { GET as portalAccess } from "@/app/api/portal/access/route";
import { GET as listAgencies, POST as createAgency } from "@/app/api/agencies/route";
import { POST as setAgencyAccess } from "@/app/api/agencies/[id]/access/route";
import { POST as setAgencyIndividual } from "@/app/api/agencies/[id]/individuals/route";
import { POST as setAgencyEmployee } from "@/app/api/agencies/[id]/employees/route";
import { POST as setGlobalRole } from "@/app/api/portal/roles/route";
import { POST as setIndividualAccess } from "@/app/api/portal/assignments/individuals/route";
import { POST as setEmployeeAccess } from "@/app/api/portal/assignments/employees/route";

const ID = "00000000-0000-4000-8000-000000000001";
const params = { params: Promise.resolve({ id: ID }) };

function request(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

describe("portal API authorization boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiPortalUser.mockResolvedValue(null);
  });

  it("returns 401 for an unauthenticated current-portal read", async () => {
    const response = await portalAccess(new NextRequest("http://localhost/api/portal/access"));
    expect(response.status).toBe(401);
    expect(mocks.getPortalHomeReadModel).not.toHaveBeenCalled();
  });

  it("passes the requested reporting month to the capability-scoped read model", async () => {
    const pool = { query: vi.fn(), connect: vi.fn() };
    const access = { userId: "portal-user", globalRoles: [], agencyAccess: [], individualLinks: [], employeeLinks: [] };
    mocks.apiPortalUser.mockResolvedValue({ pool, access });
    mocks.getPortalHomeReadModel.mockResolvedValue({ month: "2024-02" });

    const response = await portalAccess(new NextRequest("http://localhost/api/portal/access?month=2024-02"));

    expect(response.status).toBe(200);
    expect(mocks.getPortalHomeReadModel).toHaveBeenCalledWith(pool, access, "2024-02");
  });

  const ownerCases: Array<[string, () => Promise<Response>]> = [
    ["list agencies", () => listAgencies()],
    ["create an agency", () => createAgency(request("/api/agencies"))],
    ["set agency access", () => setAgencyAccess(request(`/api/agencies/${ID}/access`), params)],
    ["set agency individual membership", () => setAgencyIndividual(request(`/api/agencies/${ID}/individuals`), params)],
    ["set agency employee membership", () => setAgencyEmployee(request(`/api/agencies/${ID}/employees`), params)],
    ["set a global portal role", () => setGlobalRole(request("/api/portal/roles"))],
    ["set individual access", () => setIndividualAccess(request("/api/portal/assignments/individuals"))],
    ["set employee access", () => setEmployeeAccess(request("/api/portal/assignments/employees"))],
  ];

  it.each(ownerCases)("denies %s before calling a management service", async (_label, invoke) => {
    const response = await invoke();
    expect(response.status).toBe(403);
    expect(mocks.createAgency).not.toHaveBeenCalled();
    expect(mocks.listAgencies).not.toHaveBeenCalled();
    expect(mocks.setAgencyUserAccess).not.toHaveBeenCalled();
    expect(mocks.setAgencyIndividualMembership).not.toHaveBeenCalled();
    expect(mocks.setAgencyEmployeeMembership).not.toHaveBeenCalled();
    expect(mocks.setGlobalPortalRoleAssignment).not.toHaveBeenCalled();
    expect(mocks.setIndividualPortalAssignment).not.toHaveBeenCalled();
    expect(mocks.setEmployeePortalAssignment).not.toHaveBeenCalled();
  });
});
