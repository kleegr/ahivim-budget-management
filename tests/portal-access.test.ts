import { describe, expect, it, vi } from "vitest";
import {
  canAccessPortalIndividual,
  hasPortalCapability,
  hasPortalIndividualCapability,
  portalCapabilityAllowedForRole,
  resolvePortalAccess,
  type PortalAccessContext,
} from "@/lib/auth/portal-access";
import type { PgLikePool } from "@/lib/import/commit";

const USER = "00000000-0000-4000-8000-000000000001";
const AGENCY_A = "00000000-0000-4000-8000-000000000002";
const AGENCY_B = "00000000-0000-4000-8000-000000000003";
const INDIVIDUAL = "00000000-0000-4000-8000-000000000004";
const OTHER_INDIVIDUAL = "00000000-0000-4000-8000-000000000005";

function resolverPool(): PgLikePool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM user_portal_roles")) {
      return {
        rows: [{
          portal_role: "parent",
          capability_grants: [],
          capability_denials: ["financials.self.direct_checks.read"],
        }],
      };
    }
    if (sql.includes("FROM user_agency_access")) {
      return {
        rows: [
          {
            portal_role: "scheduler",
            capability_grants: ["financials.agency.billed_totals.read"],
            capability_denials: [],
            agency_id: AGENCY_A,
            agency_code: "A",
            agency_name: "Agency A",
          },
          {
            portal_role: "agency",
            capability_grants: [],
            capability_denials: [],
            agency_id: AGENCY_B,
            agency_code: "B",
            agency_name: "Agency B",
          },
        ],
      };
    }
    if (sql.includes("FROM user_individual_relationships")) {
      return {
        rows: [{
          individual_id: INDIVIDUAL,
          relationship_type: "guardian",
          capability_grants: [
            "financials.self.billed_totals.read",
            "financials.self.direct_checks.read",
          ],
          capability_denials: [],
        }],
      };
    }
    if (sql.includes("FROM user_employee_relationships")) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { query, connect: vi.fn() } as unknown as PgLikePool;
}

describe("portal authorization context", () => {
  it("keeps capabilities scoped to the exact agency assignment", async () => {
    const pool = resolverPool();
    const context = await resolvePortalAccess(pool, { id: USER });

    expect(hasPortalCapability(context, "hours_budgets.agency.read", AGENCY_A)).toBe(true);
    expect(hasPortalCapability(context, "schedules.agency.manage", AGENCY_A)).toBe(true);
    expect(hasPortalCapability(context, "financials.agency.billed_totals.read", AGENCY_A)).toBe(false);
    expect(hasPortalCapability(context, "financials.agency.billed_totals.read", AGENCY_B)).toBe(true);
    expect(hasPortalCapability(context, "schedules.agency.manage", AGENCY_B)).toBe(false);

    const queriedSql = vi.mocked(pool.query).mock.calls.map(([sql]) => sql).join("\n");
    expect(queriedSql).not.toMatch(/payroll_transactions|assignments|service_allocations/i);
  });

  it("lets a direct relationship narrow or grant subject visibility, with denials winning", async () => {
    const context = await resolvePortalAccess(resolverPool(), { id: USER });

    expect(hasPortalIndividualCapability(context, INDIVIDUAL, "people.self.read")).toBe(true);
    expect(hasPortalIndividualCapability(context, INDIVIDUAL, "financials.self.billed_totals.read")).toBe(true);
    expect(hasPortalIndividualCapability(context, INDIVIDUAL, "financials.self.direct_checks.read")).toBe(false);
    expect(hasPortalIndividualCapability(context, OTHER_INDIVIDUAL, "people.self.read")).toBe(false);
  });

  it("does not infer another person through a direct relationship", async () => {
    const context: PortalAccessContext = {
      userId: USER,
      globalRoles: [{ role: "parent", grants: [], denials: [] }],
      agencyAccess: [],
      individualLinks: [{
        individualId: INDIVIDUAL,
        relationship: "guardian",
        grants: [],
        denials: [],
      }],
      employeeLinks: [],
    };
    const query = vi.fn();
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    await expect(canAccessPortalIndividual(pool, context, INDIVIDUAL)).resolves.toBe(true);
    await expect(canAccessPortalIndividual(pool, context, OTHER_INDIVIDUAL)).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it("requires an explicit account role as well as a direct subject link", () => {
    const linkOnly: PortalAccessContext = {
      userId: USER,
      globalRoles: [],
      agencyAccess: [],
      individualLinks: [{
        individualId: INDIVIDUAL,
        relationship: "guardian",
        grants: ["financials.self.billed_totals.read"],
        denials: [],
      }],
      employeeLinks: [],
    };

    expect(hasPortalIndividualCapability(linkOnly, INDIVIDUAL, "people.self.read")).toBe(false);
    expect(hasPortalIndividualCapability(linkOnly, INDIVIDUAL, "financials.self.billed_totals.read")).toBe(false);
  });

  it("separates settlement read and manage capabilities", () => {
    const collector: PortalAccessContext = {
      userId: USER,
      globalRoles: [],
      agencyAccess: [{
        agencyId: AGENCY_A,
        agencyCode: "A",
        agencyName: "Agency A",
        role: "collector",
        grants: [],
        denials: [],
      }],
      individualLinks: [],
      employeeLinks: [],
    };
    const agencyReadOnly: PortalAccessContext = {
      ...collector,
      agencyAccess: [{ ...collector.agencyAccess[0]!, role: "agency" }],
    };

    expect(hasPortalCapability(collector, "settlements.agency.read", AGENCY_A)).toBe(true);
    expect(hasPortalCapability(collector, "settlements.agency.manage", AGENCY_A)).toBe(false);
    expect(hasPortalCapability(agencyReadOnly, "settlements.agency.read", AGENCY_A)).toBe(true);
    expect(hasPortalCapability(agencyReadOnly, "settlements.agency.manage", AGENCY_A)).toBe(false);
  });

  it("allows only the hours-operations roles to mutate their scoped workflow", () => {
    expect(portalCapabilityAllowedForRole("agency", "people.agency.manage")).toBe(false);
    expect(portalCapabilityAllowedForRole("staffing_manager", "assignments.agency.manage")).toBe(true);
    expect(portalCapabilityAllowedForRole("staffing_manager", "schedules.agency.manage")).toBe(true);
    expect(portalCapabilityAllowedForRole("scheduler", "schedules.agency.manage")).toBe(true);
    expect(portalCapabilityAllowedForRole("scheduler", "assignments.agency.manage")).toBe(false);
    expect(portalCapabilityAllowedForRole("collector", "settlements.agency.manage")).toBe(false);
    expect(portalCapabilityAllowedForRole("scheduler", "transactions.agency.read")).toBe(false);
    expect(portalCapabilityAllowedForRole("scheduler", "financials.agency.direct_checks.read")).toBe(false);
    expect(portalCapabilityAllowedForRole("staffing_manager", "employee_checks.self.net.read")).toBe(false);
  });

  it("does not grant portal categories that have no rendered read model", () => {
    expect(portalCapabilityAllowedForRole("parent", "schedules.self.read")).toBe(false);
    expect(portalCapabilityAllowedForRole("employee", "assignments.self.read")).toBe(false);
    expect(portalCapabilityAllowedForRole("employee", "employee_pay.self.read")).toBe(true);
    expect(portalCapabilityAllowedForRole("agency", "transactions.agency.read")).toBe(false);
    expect(portalCapabilityAllowedForRole("scheduler", "schedules.agency.read")).toBe(true);
  });
});
