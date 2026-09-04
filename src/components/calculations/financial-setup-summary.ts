import { dec } from "@/lib/money";

/** The fields needed to total the Financial Setup overview. */
export interface FinancialSetupSummaryRow {
  id: string;
  individualId: string;
  status: string;
  yearlyGross: string;
  monthlyGross: string;
  net: string;
  afterAll: string | null;
}

export interface FinancialSetupSummary {
  yearly: string;
  monthly: string;
  calculated: string;
  approved: string;
  approvedCount: number;
  activeCount: number;
  individualCount: number;
}

/**
 * Totals only current setups. Archived rows are immutable evidence and must not
 * silently return to the live monthly plan when history is shown.
 */
export function summarizeFinancialSetups(
  rows: readonly FinancialSetupSummaryRow[],
): FinancialSetupSummary {
  let yearly = dec(0);
  let monthly = dec(0);
  let calculated = dec(0);
  let approved = dec(0);
  let approvedCount = 0;
  let activeCount = 0;
  const individuals = new Set<string>();

  for (const row of rows) {
    if (row.status !== "active") continue;
    activeCount++;
    individuals.add(row.individualId);
    yearly = yearly.plus(dec(row.yearlyGross));
    monthly = monthly.plus(dec(row.monthlyGross));
    calculated = calculated.plus(dec(row.net));
    if (row.afterAll !== null) {
      approved = approved.plus(dec(row.afterAll));
      approvedCount++;
    }
  }

  return {
    yearly: yearly.toFixed(2),
    monthly: monthly.toFixed(2),
    calculated: calculated.toFixed(2),
    approved: approved.toFixed(2),
    approvedCount,
    activeCount,
    individualCount: individuals.size,
  };
}

/** Resolve a stable multi-row selection without ever selecting archived rows. */
export function selectedFinancialSetups<T extends FinancialSetupSummaryRow>(
  rows: readonly T[],
  selectedIds: ReadonlySet<string>,
): T[] {
  if (selectedIds.size === 0) return [];
  return rows.filter((row) => row.status === "active" && selectedIds.has(row.id));
}
