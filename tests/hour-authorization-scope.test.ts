import { describe, expect, it, vi } from "vitest";
import type { AccessScope } from "@/lib/auth/access";
import {
  canChangeHourAuthorization,
  canChangeHourBudgetPeriod,
  canCreateHourAuthorization,
  canCreateHourProgramBudget,
} from "@/lib/auth/hour-authorization-access";
import type { PgLikePool } from "@/lib/import/commit";

const AUTHORIZATION_ID = "00000000-0000-4000-8000-000000000001";
const PERIOD_ID = "00000000-0000-4000-8000-000000000002";
const PROGRAM_ID = "00000000-0000-4000-8000-000000000003";
const INDIVIDUAL_ID = "00000000-0000-4000-8000-000000000004";
const OTHER_INDIVIDUAL_ID = "00000000-0000-4000-8000-000000000005";

function plannerScope(): AccessScope {
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
    allIndividuals: false,
    allEmployees: true,
    individualIds: [INDIVIDUAL_ID],
    employeeIds: [],
    grantedIndividualIds: [INDIVIDUAL_ID],
    grantedEmployeeIds: [],
  };
}

describe("hour authorization subject and program scope", () => {
  it("requires a direct individual grant before looking up an hours program", async () => {
    const query = vi.fn(async () => ({ rows: [{ allowed: true }] }));
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    await expect(canCreateHourProgramBudget(
      pool,
      plannerScope(),
      OTHER_INDIVIDUAL_ID,
      PROGRAM_ID,
    )).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it("allows creation only when the database program is exactly hours-only", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("required_auth_type = 'hours'");
      expect(sql).toContain("code <> 'CLASSES'");
      return { rows: [{ allowed: true }] };
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    await expect(canCreateHourProgramBudget(
      pool,
      plannerScope(),
      INDIVIDUAL_ID,
      PROGRAM_ID,
    )).resolves.toBe(true);
  });

  it("checks both the period subject and exact program type for direct creation", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("program.required_auth_type = 'hours'");
      expect(sql).toContain("period.status = 'active'");
      return { rows: [{ individual_id: INDIVIDUAL_ID }] };
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    await expect(canCreateHourAuthorization(
      pool,
      plannerScope(),
      PERIOD_ID,
      PROGRAM_ID,
    )).resolves.toBe(true);
  });

  it("checks the stored program type and subject before revise or cancel", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("program.required_auth_type = 'hours'");
      expect(sql).toContain("authorization.individual_id");
      return { rows: [{ individual_id: OTHER_INDIVIDUAL_ID }] };
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    await expect(canChangeHourAuthorization(
      pool,
      plannerScope(),
      AUTHORIZATION_ID,
    )).resolves.toBe(false);
  });

  it("allows a renewal change only when every active line in the period is hours-only", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("bool_and");
      expect(sql).toContain("program.required_auth_type = 'hours'");
      return { rows: [{ individual_id: INDIVIDUAL_ID, allowed: true }] };
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    await expect(canChangeHourBudgetPeriod(
      pool,
      plannerScope(),
      PERIOD_ID,
    )).resolves.toBe(true);
  });
});
