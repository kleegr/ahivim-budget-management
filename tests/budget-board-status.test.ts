import { describe, expect, it } from "vitest";
import {
  countActiveBillingWithoutBudget,
  isActiveBillingWithoutBudget,
  isActiveOverAuthorization,
  type BudgetBoardStatusRow,
} from "@/lib/business/budget-board-status";

function row(overrides: Partial<BudgetBoardStatusRow> = {}): BudgetBoardStatusRow {
  return {
    status: "active",
    archived: false,
    hasBilling: false,
    budget: null,
    ...overrides,
  };
}

describe("budget board action populations", () => {
  it("counts billed active people with no usable budget and excludes inactive history", () => {
    expect(isActiveBillingWithoutBudget(row({ hasBilling: true }))).toBe(true);
    expect(isActiveBillingWithoutBudget(row({ hasBilling: true, status: "inactive" }))).toBe(false);
    expect(isActiveBillingWithoutBudget(row({ hasBilling: true, archived: true }))).toBe(false);
    expect(isActiveBillingWithoutBudget(row({ hasBilling: true, budget: { status: "not_started", plainStatus: "unused" } }))).toBe(false);
  });

  it("finds billing without budget in a mixed active portfolio", () => {
    const activeIndividuals = [
      row({ hasBilling: true }),
      row({ hasBilling: false }),
      row({ hasBilling: true, budget: { status: "on_pace", plainStatus: "remaining" } }),
    ];

    expect(countActiveBillingWithoutBudget(activeIndividuals)).toBe(1);
  });

  it("uses the same pace and plain-balance rules for over-authorization", () => {
    expect(isActiveOverAuthorization(row({ budget: { status: "over_authorization", plainStatus: "remaining" } }))).toBe(true);
    expect(isActiveOverAuthorization(row({ budget: { status: "on_pace", plainStatus: "over" } }))).toBe(true);
    expect(isActiveOverAuthorization(row({ status: "inactive", budget: { status: "over_authorization", plainStatus: "over" } }))).toBe(false);
    expect(isActiveOverAuthorization(row({ archived: true, budget: { status: "over_authorization", plainStatus: "over" } }))).toBe(false);
  });
});
