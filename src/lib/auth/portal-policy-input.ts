import type { PortalCapability } from "./portal-access";

const SELF_VISIBILITY_FIELDS: Record<string, PortalCapability> = {
  billedTotals: "financials.self.billed_totals.read",
  cutsSetAsides: "financials.self.cuts_set_asides.read",
  directChecks: "financials.self.direct_checks.read",
  agencyPaidAmounts: "financials.self.agency_paid.read",
  dollarBudgets: "dollar_budgets.self.read",
  checkGross: "employee_checks.self.gross.read",
  checkNet: "employee_checks.self.net.read",
  checkTax: "employee_checks.self.tax.read",
  giveBack: "employee_giveback.self.read",
};

const AGENCY_VISIBILITY_FIELDS: Record<string, PortalCapability> = {
  billedTotals: "financials.agency.billed_totals.read",
  cutsSetAsides: "financials.agency.cuts_set_asides.read",
  directChecks: "financials.agency.direct_checks.read",
  agencyPaidAmounts: "financials.agency.agency_paid.read",
  dollarBudgets: "dollar_budgets.agency.read",
};

/** Convert the admin form's Show/Hide/Role default controls into policy arrays. */
export function portalPolicyFromInput(
  body: Record<string, unknown>,
  scope: "self" | "agency",
): { capabilityGrants?: string[]; capabilityDenials?: string[] } {
  if (Array.isArray(body.capabilityGrants) || Array.isArray(body.capabilityDenials)) {
    return {
      capabilityGrants: Array.isArray(body.capabilityGrants) ? body.capabilityGrants.map(String) : undefined,
      capabilityDenials: Array.isArray(body.capabilityDenials) ? body.capabilityDenials.map(String) : undefined,
    };
  }
  const fields = scope === "self" ? SELF_VISIBILITY_FIELDS : AGENCY_VISIBILITY_FIELDS;
  const values = Object.entries(fields).filter(([field]) => field in body);
  if (values.length === 0) return {};
  const capabilityGrants: PortalCapability[] = [];
  const capabilityDenials: PortalCapability[] = [];
  for (const [field, capability] of values) {
    if (body[field] === "show") capabilityGrants.push(capability);
    if (body[field] === "hide") capabilityDenials.push(capability);
  }
  return { capabilityGrants, capabilityDenials };
}
