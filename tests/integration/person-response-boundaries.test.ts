import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fullAccess, type AccessScope } from "@/lib/auth/access";
import { closeTestPool, hasTestDatabase, resetSchema, testPool, truncateBusinessTables } from "../support/database";

const boundary = vi.hoisted(() => ({ user: vi.fn(), pool: vi.fn(), scope: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ apiUser: boundary.user }));
vi.mock("@/lib/db", () => ({ getPool: boundary.pool }));
vi.mock("@/lib/auth/access", async (original) => ({
  ...await original<typeof import("@/lib/auth/access")>(), resolveAccessScope: boundary.scope,
}));
import { GET as individual } from "@/app/api/individuals/[id]/route";
import { GET as individuals } from "@/app/api/individuals/route";
import { GET as employee } from "@/app/api/employees/[id]/route";
import { GET as employees } from "@/app/api/employees/route";

const PERSON = "b1000000-0000-4000-8000-000000000001";
const EMPLOYEE = "b2000000-0000-4000-8000-000000000001";
const SECRET = "PRIVATE-FINANCIAL-NOTE-987654.32";
const REFERENCE = "PRIVATE-PAYROLL-REFERENCE-76543";
let scope: AccessScope;
const suite = hasTestDatabase ? describe : describe.skip;

suite("person response boundaries use real stored sentinel data", () => {
  beforeAll(resetSchema, 60_000);
  afterAll(closeTestPool);
  beforeEach(async () => {
    await truncateBusinessTables();
    const pool = testPool();
    await pool.query("INSERT INTO individuals (id,display_name,normalized_name,external_ref,notes,phone) VALUES($1,'Visible Person','visible-person',$2,$3,'212-555-0123')", [PERSON, REFERENCE, SECRET]);
    await pool.query("INSERT INTO employees (id,display_name,normalized_name,external_ref,notes,payout_cut_percent) VALUES($1,'Visible Employee','visible-employee',$2,$3,0.19)", [EMPLOYEE, REFERENCE, SECRET]);
    scope = { ...fullAccess("viewer", "viewer"), full: false, allIndividuals: false, allEmployees: false,
      individualIds: [PERSON], employeeIds: [EMPLOYEE], grantedIndividualIds: [], grantedEmployeeIds: [],
      canSeeMoney: false, canSeeEmployeeDeals: false, canSeeTransactions: false, canPlan: false,
    };
    boundary.user.mockResolvedValue({ id: "viewer", role: "viewer" });
    boundary.pool.mockReturnValue(pool);
    boundary.scope.mockImplementation(async () => scope);
  });

  async function responses() {
    const request = (path: string) => new NextRequest(`http://localhost${path}`);
    return [
      await individual(request(`/api/individuals/${PERSON}`), { params: Promise.resolve({ id: PERSON }) }),
      await individuals(request("/api/individuals")),
      await employee(request(`/api/employees/${EMPLOYEE}`), { params: Promise.resolve({ id: EMPLOYEE }) }),
      await employees(request("/api/employees")),
    ];
  }

  it("retains visible identity while withholding private source data for indirect navigation", async () => {
    for (const response of await responses()) {
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("Visible");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(REFERENCE);
      expect(text).not.toContain("212-555-0123");
      expect(text).not.toContain("payoutCutPercent");
    }
  });

  it("keeps restricted direct roster grants from inheriting unclassified private notes", async () => {
    scope.allIndividuals = true;
    scope.allEmployees = true;
    scope.canPlan = true;
    for (const response of await responses()) {
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("Visible");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(REFERENCE);
    }
  });

  it("preserves the owner's complete profile workflow", async () => {
    scope = fullAccess("owner", "admin");
    for (const response of await responses()) {
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain(SECRET);
      expect(text).toContain(REFERENCE);
    }
  });

  it("honors category denials even for a legacy full-roster viewer", async () => {
    scope.full = true;
    scope.allIndividuals = true;
    scope.allEmployees = true;
    for (const response of await responses()) {
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("Visible");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(REFERENCE);
      expect(text).not.toContain("payoutCutPercent");
    }
  });
});
