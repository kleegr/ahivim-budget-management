import { describe, expect, it, vi } from "vitest";
import {
  fullAccess,
  canAccessPlanning,
  isPlanningOnlyAccess,
  hasDirectEmployeeAccess,
  hasDirectIndividualAccess,
  resolveAccessScope,
  transactionScopeClause,
  type AccessScope,
} from "@/lib/auth/access";
import {
  redactTransactionFields,
  redactTransactionMoney,
  transactionFieldVisibility,
} from "@/lib/auth/money-redaction";
import { listTransactionsForGrid } from "@/lib/data/transactions-grid";
import type { PgLikePool } from "@/lib/import/commit";

const INDIVIDUAL_A = "00000000-0000-4000-8000-000000000001";
const INDIVIDUAL_CONNECTED = "00000000-0000-4000-8000-000000000002";
const EMPLOYEE_GRANTED = "00000000-0000-4000-8000-000000000003";
const EMPLOYEE_COWORKER = "00000000-0000-4000-8000-000000000004";

function scoped(overrides: Partial<AccessScope> = {}): AccessScope {
  return {
    userId: "viewer-1",
    role: "viewer",
    full: false,
    canSeeTransactions: true,
    canSeeMoney: true,
    canSeeHours: true,
    canSeeBilledAmounts: true,
    canSeeEmployeeAmounts: true,
    canSeeAgencySpread: true,
    canSeeCheckNet: true,
    canSeeTaxes: true,
    canSeeBudgets: true,
    canSeeEmployeeDeals: false,
    canSeeSettlements: false,
    canSeeClassFinancials: false,
    canManageClassInvoices: false,
    canEditDocuments: false,
    canPlan: false,
    allIndividuals: false,
    allEmployees: false,
    individualIds: [],
    employeeIds: [],
    grantedIndividualIds: [],
    grantedEmployeeIds: [],
    ...overrides,
  };
}

describe("transaction access scope", () => {
  it("only enables portfolio-wide Planning for full-roster access", () => {
    expect(canAccessPlanning(scoped({ canPlan: true }))).toBe(false);
    expect(canAccessPlanning(scoped({ canPlan: true, allIndividuals: true, allEmployees: true }))).toBe(true);
    expect(canAccessPlanning(fullAccess("manager-1", "manager"))).toBe(true);
    expect(isPlanningOnlyAccess(scoped({
      canPlan: true,
      allIndividuals: true,
      allEmployees: true,
      canSeeTransactions: false,
      canSeeMoney: false,
    }))).toBe(true);
    expect(isPlanningOnlyAccess(fullAccess("manager-1", "manager"))).toBe(false);
  });

  it("does not let an employee grant expose coworker rows through connected individuals", () => {
    const scope = scoped({
      // The connected individual belongs in navigation, but is not a ledger grant.
      individualIds: [INDIVIDUAL_CONNECTED],
      employeeIds: [EMPLOYEE_GRANTED],
      grantedEmployeeIds: [EMPLOYEE_GRANTED],
    });
    const params: unknown[] = [];

    const clause = transactionScopeClause(
      scope,
      "t.individual_id",
      "t.employee_id",
      params,
    );

    expect(clause).toBe(" AND (t.employee_id = ANY($1::uuid[]))");
    expect(params).toEqual([[EMPLOYEE_GRANTED]]);
    expect(params).not.toContainEqual([INDIVIDUAL_CONNECTED]);
    expect(clause).not.toContain("t.individual_id = ANY");
  });

  it("combines only direct individual and employee grants", () => {
    const scope = scoped({
      individualIds: [INDIVIDUAL_A, INDIVIDUAL_CONNECTED],
      employeeIds: [EMPLOYEE_GRANTED, EMPLOYEE_COWORKER],
      grantedIndividualIds: [INDIVIDUAL_A],
      grantedEmployeeIds: [EMPLOYEE_GRANTED],
    });
    const params: unknown[] = ["existing-filter"];

    const clause = transactionScopeClause(
      scope,
      "t.individual_id",
      "t.employee_id",
      params,
    );

    expect(clause).toBe(
      " AND (t.individual_id = ANY($2::uuid[]) OR t.employee_id = ANY($3::uuid[]))",
    );
    expect(params).toEqual(["existing-filter", [INDIVIDUAL_A], [EMPLOYEE_GRANTED]]);
  });

  it("does not treat connected navigation people as direct financial grants", () => {
    const scope = scoped({
      individualIds: [INDIVIDUAL_A, INDIVIDUAL_CONNECTED],
      employeeIds: [EMPLOYEE_GRANTED, EMPLOYEE_COWORKER],
      grantedIndividualIds: [INDIVIDUAL_A],
      grantedEmployeeIds: [EMPLOYEE_GRANTED],
    });

    expect(hasDirectIndividualAccess(scope, INDIVIDUAL_A)).toBe(true);
    expect(hasDirectIndividualAccess(scope, INDIVIDUAL_CONNECTED)).toBe(false);
    expect(hasDirectEmployeeAccess(scope, EMPLOYEE_GRANTED)).toBe(true);
    expect(hasDirectEmployeeAccess(scope, EMPLOYEE_COWORKER)).toBe(false);
  });

  it("keeps full access unfiltered and denies a scoped user with no grants", () => {
    const fullParams: unknown[] = [];
    expect(transactionScopeClause(fullAccess("admin-1", "admin"), "i", "e", fullParams)).toBe("");
    expect(fullParams).toEqual([]);

    const emptyParams: unknown[] = [];
    expect(transactionScopeClause(scoped(), "i", "e", emptyParams)).toBe(" AND FALSE");
    expect(emptyParams).toEqual([]);
  });

  it("preserves direct grants separately from connected navigation ids", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM users")) {
        return {
          rows: [{
            access_scope: "scoped",
            see_all_individuals: false,
            see_all_employees: false,
            can_see_transactions: true,
            can_see_money: true,
            can_see_hours: false,
            can_see_billed_amounts: true,
            can_see_employee_amounts: false,
            can_see_agency_spread: true,
            can_see_check_net: false,
            can_see_taxes: true,
            can_see_budgets: true,
            can_see_employee_deals: true,
            can_see_settlements: false,
            can_plan: true,
          }],
        };
      }
      if (sql.includes("FROM user_individual_access")) {
        return { rows: [{ individual_id: INDIVIDUAL_A }] };
      }
      if (sql.includes("FROM user_employee_access")) {
        return { rows: [{ employee_id: EMPLOYEE_GRANTED }] };
      }
      if (sql.includes("WHERE employee_id = ANY")) {
        return { rows: [{ individual_id: INDIVIDUAL_CONNECTED }] };
      }
      if (sql.includes("WHERE individual_id = ANY")) {
        return { rows: [{ employee_id: EMPLOYEE_COWORKER }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;

    const scope = await resolveAccessScope(pool, { id: "viewer-1", role: "viewer" });

    expect(scope.grantedIndividualIds).toEqual([INDIVIDUAL_A]);
    expect(scope.grantedEmployeeIds).toEqual([EMPLOYEE_GRANTED]);
    expect(scope.individualIds).toEqual([INDIVIDUAL_A, INDIVIDUAL_CONNECTED]);
    expect(scope.employeeIds).toEqual([EMPLOYEE_GRANTED, EMPLOYEE_COWORKER]);
    expect(scope).toMatchObject({
      canSeeHours: false,
      canSeeBilledAmounts: true,
      canSeeEmployeeAmounts: false,
      canSeeAgencySpread: true,
      canSeeCheckNet: false,
      canSeeTaxes: true,
      canSeeBudgets: false,
      canSeeEmployeeDeals: true,
      canSeeSettlements: false,
      canPlan: true,
    });
  });

  it("fails closed if the viewer disappears between session and scope checks", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(),
    } as unknown as PgLikePool;

    const scope = await resolveAccessScope(pool, { id: "removed-viewer", role: "viewer" });

    expect(scope).toMatchObject({
      full: false,
      canSeeTransactions: false,
      canSeeMoney: false,
      canSeeBudgets: false,
      canSeeEmployeeDeals: false,
      canSeeSettlements: false,
      canPlan: false,
      individualIds: [],
      employeeIds: [],
    });
  });
});

describe("server-side transaction money redaction", () => {
  it("removes money, net and tax values while preserving hours", () => {
    const row = {
      id: "row-1",
      hours: "8.00",
      rate: "25.00",
      gross: "200.00",
      internalAmount: "168.00",
      totalNetPay: "150.00",
      withheld: "18.00",
      tax: "18.00",
    };

    expect(redactTransactionMoney(row, false)).toEqual({
      id: "row-1",
      hours: "8.00",
      rate: null,
      gross: null,
      internalAmount: null,
      totalNetPay: null,
      withheld: null,
      tax: null,
    });
    expect(row.rate).toBe("25.00");
  });

  it("redacts each transaction category independently", () => {
    const row = {
      hours: "8.00",
      rate: "25.00",
      gross: "200.00",
      internalAmount: "168.00",
      agencyAdditional: "32.00",
      totalNetPay: "150.00",
      withheld: "18.00",
    };
    const permissions = scoped({
      canSeeHours: false,
      canSeeBilledAmounts: true,
      canSeeEmployeeAmounts: false,
      canSeeAgencySpread: false,
      canSeeCheckNet: true,
      canSeeTaxes: false,
    });

    expect(redactTransactionFields(row, permissions)).toEqual({
      hours: null,
      rate: "25.00",
      gross: "200.00",
      internalAmount: null,
      agencyAdditional: null,
      totalNetPay: "150.00",
      withheld: null,
    });
  });

  it("uses canSeeMoney as a master guard for every monetary category", () => {
    const permissions = scoped({
      canSeeMoney: false,
      canSeeBilledAmounts: true,
      canSeeEmployeeAmounts: true,
      canSeeAgencySpread: true,
      canSeeCheckNet: true,
      canSeeTaxes: true,
      canSeeEmployeeDeals: true,
      canSeeSettlements: true,
    });

    expect(transactionFieldVisibility(permissions)).toEqual({
      canSeeMoney: false,
      canSeeHours: true,
      canSeeBilledAmounts: false,
      canSeeEmployeeAmounts: false,
      canSeeAgencySpread: false,
      canSeeCheckNet: false,
      canSeeTaxes: false,
    });
  });

  it("returns no hidden money in the grid rows passed to the client", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        id: "row-1",
        pay_to: "Employee One",
        check_date: "2026-08-01",
        check_number: "1001",
        hours: "8.00",
        rate: "25.00",
        gross: "200.00",
        total_net_pay: "150.00",
        period_begin: "2026-07-20",
        period_end: "2026-08-01",
        program: "Com Hab",
        program_code: "COM_HAB",
        program_id: null,
        individual: "Individual One",
        individual_id: INDIVIDUAL_A,
        employee: "Employee One",
        employee_id: EMPLOYEE_GRANTED,
        internal_amount: "168.00",
        agency_additional: "32.00",
        payment_recipient: "employee",
        import_batch_id: null,
        import_row_id: null,
        source_file_id: null,
        match_status: "new",
        is_group: false,
        service_session_id: null,
        is_paid: false,
        paid_at: null,
        paid_note: null,
      }],
    }));
    const pool = { query, connect: vi.fn() } as unknown as PgLikePool;
    const scope = { ...fullAccess("viewer-1", "viewer"), canSeeMoney: false };

    const rows = await listTransactionsForGrid(pool, scope);

    expect(rows[0]).toMatchObject({
      hours: "8.00",
      rate: null,
      gross: null,
      totalNetPay: null,
      internalAmount: null,
      agencyAdditional: null,
    });
    expect(JSON.stringify(rows[0])).not.toMatch(/25\.00|200\.00|150\.00|168\.00|32\.00/);
  });
});
