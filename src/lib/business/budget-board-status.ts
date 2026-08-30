export interface BudgetBoardStatusRow {
  status: string;
  archived: boolean;
  hasBilling: boolean;
  budget: {
    status: string;
    plainStatus: string;
  } | null;
}

export function isActiveBillingWithoutBudget(row: BudgetBoardStatusRow): boolean {
  return row.status === "active" && !row.archived && row.hasBilling && row.budget === null;
}

export function countActiveBillingWithoutBudget(rows: readonly BudgetBoardStatusRow[]): number {
  return rows.filter(isActiveBillingWithoutBudget).length;
}

export function isActiveOverAuthorization(row: BudgetBoardStatusRow): boolean {
  return row.status === "active"
    && !row.archived
    && row.budget !== null
    && (row.budget.status === "over_authorization" || row.budget.plainStatus === "over");
}
