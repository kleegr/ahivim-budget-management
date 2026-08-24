import { describe, expect, it } from "vitest";
import { canOperateSettlementPerson } from "@/lib/auth/settlement-operator";
import type { AccessScope } from "@/lib/auth/access";

function financeScope(overrides: Partial<AccessScope> = {}): AccessScope {
  return {
    userId: "user-1",
    role: "viewer",
    full: false,
    canSeeTransactions: true,
    canSeeMoney: true,
    canSeeHours: false,
    canSeeBilledAmounts: false,
    canSeeEmployeeAmounts: true,
    canSeeAgencySpread: false,
    canSeeCheckNet: true,
    canSeeTaxes: false,
    canSeeBudgets: false,
    canSeeEmployeeDeals: false,
    canSeeSettlements: true,
    allIndividuals: false,
    allEmployees: false,
    individualIds: [],
    employeeIds: [],
    grantedIndividualIds: ["individual-1"],
    grantedEmployeeIds: ["employee-1"],
    ...overrides,
  };
}

describe("finance operator person scope", () => {
  it("permits only explicitly granted people for a scoped finance account", () => {
    const scope = financeScope();
    expect(canOperateSettlementPerson(scope, { employeeId: "employee-1", individualId: null })).toBe(true);
    expect(canOperateSettlementPerson(scope, { employeeId: "employee-2", individualId: null })).toBe(false);
    expect(canOperateSettlementPerson(scope, { employeeId: null, individualId: "individual-1" })).toBe(true);
    expect(canOperateSettlementPerson(scope, { employeeId: null, individualId: "individual-2" })).toBe(false);
  });

  it("permits the corresponding person type when the all-people switch is enabled", () => {
    const scope = financeScope({ allEmployees: true, allIndividuals: true });
    expect(canOperateSettlementPerson(scope, { employeeId: "employee-9", individualId: null })).toBe(true);
    expect(canOperateSettlementPerson(scope, { employeeId: null, individualId: "individual-9" })).toBe(true);
  });
});
