import type { AccessScope } from "@/lib/auth/access";

export type ReportPermission =
  | "canSeeTransactions"
  | "canSeeHours"
  | "canSeeBilledAmounts"
  | "canSeeEmployeeAmounts"
  | "canSeeAgencySpread"
  | "canSeeCheckGross"
  | "canSeeCheckNet"
  | "canSeeTaxes"
  | "canSeeBudgets"
  | "canSeeSettlements";

export interface ReportAccessRequirement {
  /** Every listed permission must remain enabled after account overrides. */
  allOf?: readonly ReportPermission[];
  /** Reports are organization-wide until every query is access-scoped. */
  organizationWide?: boolean;
  adminOnly?: boolean;
}

const TRANSACTION_MONEY = [
  "canSeeTransactions",
  "canSeeHours",
  "canSeeBilledAmounts",
  "canSeeEmployeeAmounts",
  "canSeeAgencySpread",
] as const satisfies readonly ReportPermission[];

/**
 * Central fail-closed access policy for report pages and server exports.
 *
 * Report loaders currently aggregate at organization scope. A scoped account
 * may therefore open them only when it can see every Individual and Employee.
 * Money questions additionally require every field they expose; a granular
 * denial hides the card and blocks a guessed direct URL before its query runs.
 */
export const REPORT_ACCESS: Readonly<Record<string, ReportAccessRequirement>> = {
  "budget-utilization": { organizationWide: true, allOf: ["canSeeBudgets", "canSeeHours"] },
  "utilization-outliers": { organizationWide: true, allOf: ["canSeeBudgets", "canSeeHours"] },
  "expiring-authorizations": { organizationWide: true, allOf: ["canSeeBudgets", "canSeeHours"] },
  "billing-without-budget": {
    organizationWide: true,
    allOf: ["canSeeBudgets", "canSeeTransactions", "canSeeHours", "canSeeBilledAmounts"],
  },
  "actual-vs-scheduled": {
    organizationWide: true,
    allOf: ["canSeeTransactions", "canSeeHours", "canSeeEmployeeAmounts"],
  },

  transactions: { organizationWide: true, allOf: [...TRANSACTION_MONEY, "canSeeCheckNet"] },
  "unbilled-schedules": {
    organizationWide: true,
    allOf: ["canSeeHours", "canSeeEmployeeAmounts"],
  },
  "unscheduled-billing": {
    organizationWide: true,
    allOf: ["canSeeTransactions", "canSeeHours", "canSeeBilledAmounts"],
  },
  "group-activity": {
    organizationWide: true,
    allOf: ["canSeeTransactions", "canSeeBilledAmounts"],
  },
  "employee-activity": {
    organizationWide: true,
    allOf: ["canSeeTransactions", "canSeeHours", "canSeeBilledAmounts", "canSeeEmployeeAmounts"],
  },

  "payroll-checks": {
    organizationWide: true,
    allOf: [...TRANSACTION_MONEY, "canSeeCheckNet"],
  },
  "give-back": { organizationWide: true, allOf: ["canSeeSettlements", "canSeeEmployeeAmounts"] },
  "agency-to-employee-payments": {
    organizationWide: true,
    allOf: ["canSeeSettlements", "canSeeEmployeeAmounts"],
  },
  "individual-put-away": { organizationWide: true, allOf: ["canSeeSettlements"] },
  credits: { organizationWide: true, allOf: ["canSeeSettlements"] },
  "agency-financials": { organizationWide: true, adminOnly: true },
  "agency-earnings": {
    organizationWide: true,
    allOf: ["canSeeTransactions", "canSeeBilledAmounts", "canSeeEmployeeAmounts", "canSeeAgencySpread"],
  },
  "employee-payable": {
    organizationWide: true,
    allOf: ["canSeeTransactions", "canSeeHours", "canSeeEmployeeAmounts"],
  },

  "missing-config": { organizationWide: true, allOf: ["canSeeBudgets"] },
  "missing-rates": { organizationWide: true, allOf: ["canSeeBilledAmounts"] },
  "unverified-checks": {
    organizationWide: true,
    allOf: ["canSeeTransactions", "canSeeCheckGross", "canSeeCheckNet", "canSeeTaxes"],
  },
  "import-conflicts": { organizationWide: true, allOf: ["canSeeTransactions"] },
  "alias-decisions": { organizationWide: true },
  "audit-history": { organizationWide: true },

  // Kept for compatible bookmarked routes even though these are not catalog cards.
  "program-totals": { organizationWide: true, allOf: TRANSACTION_MONEY },
  "cuts-monthly": {
    organizationWide: true,
    allOf: ["canSeeBudgets", "canSeeEmployeeAmounts"],
  },
};

export function canAccessReport(
  reportKey: string,
  scope: AccessScope,
  role: string = scope.role,
): boolean {
  const requirement = REPORT_ACCESS[reportKey];
  // A newly-added report must opt into a reviewed policy before it is reachable.
  if (!requirement) return false;
  if (requirement.adminOnly && role !== "admin") return false;
  if (
    requirement.organizationWide
    && !(scope.full || (scope.allIndividuals && scope.allEmployees))
  ) return false;
  return (requirement.allOf ?? []).every((permission) => scope[permission] === true);
}
