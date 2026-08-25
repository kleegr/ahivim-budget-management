import type { UserAccessConfig } from "./users";

/** Full-roster, hours-only access for the staff member who manages schedules. */
export const BUDGET_PLANNER_ACCESS = {
  accessScope: "full",
  seeAllIndividuals: true,
  seeAllEmployees: true,
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
  canPlan: true,
  individualIds: [],
  employeeIds: [],
} satisfies UserAccessConfig;
