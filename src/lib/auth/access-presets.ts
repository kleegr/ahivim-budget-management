import type { UserAccessConfig } from "./users";

/** Portal accounts receive no internal workspace access unless explicitly added. */
export const PORTAL_ONLY_ACCESS = {
  accessScope: "scoped",
  seeAllIndividuals: false,
  seeAllEmployees: false,
  canSeeTransactions: false,
  canSeeMoney: false,
  canSeeHours: false,
  canSeeBilledAmounts: false,
  canSeeEmployeeAmounts: false,
  canSeeAgencySpread: false,
  canSeeCheckGross: false,
  canSeeCheckNet: false,
  canSeeTaxes: false,
  canSeeBudgets: false,
  canSeeEmployeeDeals: false,
  canSeeSettlements: false,
  canManageSettlements: false,
  canSeeClassFinancials: false,
  canManageClassInvoices: false,
  canViewDocuments: false,
  canEditDocuments: false,
  canPlan: false,
  canManagePlanning: false,
  individualIds: [],
  employeeIds: [],
} satisfies UserAccessConfig;

/** Full-roster, hours-only access for the staff member who manages schedules. */
export const BUDGET_PLANNER_ACCESS = {
  // Viewer access must remain scoped at the database boundary. The two
  // see-all switches provide the full roster without turning this into a
  // trusted manager account.
  accessScope: "scoped",
  seeAllIndividuals: true,
  seeAllEmployees: true,
  canSeeTransactions: false,
  canSeeMoney: false,
  canSeeHours: true,
  canSeeBilledAmounts: false,
  canSeeEmployeeAmounts: false,
  canSeeAgencySpread: false,
  canSeeCheckGross: false,
  canSeeCheckNet: false,
  canSeeTaxes: false,
  canSeeBudgets: true,
  canSeeEmployeeDeals: false,
  canSeeSettlements: false,
  canManageSettlements: false,
  canSeeClassFinancials: false,
  canManageClassInvoices: false,
  canViewDocuments: false,
  canEditDocuments: false,
  canPlan: true,
  canManagePlanning: true,
  individualIds: [],
  employeeIds: [],
} satisfies UserAccessConfig;

/** Full-roster staffing and schedule access without budgets or money. */
export const STAFFING_MANAGER_ACCESS = {
  ...BUDGET_PLANNER_ACCESS,
  canSeeBudgets: false,
} satisfies UserAccessConfig;

/** Full-roster financial operations without budgets or agency revenue. */
export const COLLECTIONS_ACCESS = {
  accessScope: "scoped",
  seeAllIndividuals: true,
  seeAllEmployees: true,
  canSeeTransactions: true,
  canSeeMoney: true,
  canSeeHours: false,
  canSeeBilledAmounts: false,
  canSeeEmployeeAmounts: true,
  canSeeAgencySpread: false,
  canSeeCheckGross: true,
  canSeeCheckNet: true,
  canSeeTaxes: true,
  canSeeBudgets: false,
  canSeeEmployeeDeals: true,
  canSeeSettlements: true,
  canManageSettlements: true,
  canSeeClassFinancials: false,
  canManageClassInvoices: false,
  canViewDocuments: false,
  canEditDocuments: false,
  canPlan: false,
  canManagePlanning: false,
  individualIds: [],
  employeeIds: [],
} satisfies UserAccessConfig;

/** Class allowances, invoices, generated forms, and document editing. */
export const CLASS_BILLING_ACCESS = {
  accessScope: "scoped",
  seeAllIndividuals: true,
  seeAllEmployees: false,
  canSeeTransactions: false,
  canSeeMoney: true,
  canSeeHours: false,
  canSeeBilledAmounts: false,
  canSeeEmployeeAmounts: false,
  canSeeAgencySpread: false,
  canSeeCheckGross: false,
  canSeeCheckNet: false,
  canSeeTaxes: false,
  canSeeBudgets: false,
  canSeeEmployeeDeals: false,
  canSeeSettlements: false,
  canManageSettlements: false,
  canSeeClassFinancials: true,
  canManageClassInvoices: true,
  canViewDocuments: true,
  canEditDocuments: true,
  canPlan: false,
  canManagePlanning: false,
  individualIds: [],
  employeeIds: [],
} satisfies UserAccessConfig;
