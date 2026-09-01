import type { PortalAgencySummary, PortalHomeReadModel } from "@/lib/data/portal-read-model";

export interface AgencyDirectoryReadModel {
  month: string;
  agencies: PortalAgencySummary[];
  totals: {
    agencies: number;
    individuals: number | null;
    employees: number | null;
    managedBudgets: number | null;
    billingWithoutBudget: number | null;
  };
}

function totalVisible(
  agencies: readonly PortalAgencySummary[],
  value: (agency: PortalAgencySummary) => number | null,
): number | null {
  const values = agencies.map(value);
  return values.some((item) => item === null)
    ? null
    : values.reduce<number>((sum, item) => sum + (item ?? 0), 0);
}

/**
 * Owner agency pages are a presentation of the portal-safe aggregate model.
 * No activity, budget, or financial amount is recalculated here.
 */
export function buildAgencyDirectoryReadModel(
  portal: PortalHomeReadModel,
): AgencyDirectoryReadModel {
  return {
    month: portal.month,
    agencies: portal.agencies,
    totals: {
      agencies: portal.agencies.length,
      individuals: totalVisible(portal.agencies, (agency) => agency.individualCount),
      employees: totalVisible(portal.agencies, (agency) => agency.employeeCount),
      managedBudgets: totalVisible(portal.agencies, (agency) => agency.managedBudgetCount),
      billingWithoutBudget: totalVisible(portal.agencies, (agency) => agency.billingWithoutBudgetCount),
    },
  };
}

export function findAgencyDirectoryEntry(
  directory: AgencyDirectoryReadModel,
  agencyId: string,
): PortalAgencySummary | null {
  return directory.agencies.find((agency) => agency.id === agencyId) ?? null;
}
