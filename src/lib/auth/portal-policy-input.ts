import { isPortalCapability, type PortalCapability } from "./portal-access";

export interface PortalPolicyInput {
  capabilityGrants?: string[];
  capabilityDenials?: string[];
  capabilityUpdates?: Record<string, "show" | "hide" | "default">;
}

export interface StoredPortalPolicy {
  capability_grants: string[];
  capability_denials: string[];
}

const SELF_VISIBILITY_FIELDS: Record<string, PortalCapability> = {
  approvedDocuments: "documents.self.read",
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
  approvedDocuments: "documents.self.read",
  billedTotals: "financials.agency.billed_totals.read",
  cutsSetAsides: "financials.agency.cuts_set_asides.read",
  directChecks: "financials.agency.direct_checks.read",
  agencyPaidAmounts: "financials.agency.agency_paid.read",
  dollarBudgets: "dollar_budgets.agency.read",
};

/** Convert named form controls to partial updates; explicit arrays replace their side. */
export function portalPolicyFromInput(
  body: Record<string, unknown>,
  scope: "self" | "agency",
): PortalPolicyInput {
  if (Array.isArray(body.capabilityGrants) || Array.isArray(body.capabilityDenials)) {
    return {
      capabilityGrants: Array.isArray(body.capabilityGrants) ? body.capabilityGrants.map(String) : undefined,
      capabilityDenials: Array.isArray(body.capabilityDenials) ? body.capabilityDenials.map(String) : undefined,
    };
  }
  const fields = scope === "self" ? SELF_VISIBILITY_FIELDS : AGENCY_VISIBILITY_FIELDS;
  const values = Object.entries(fields).filter(([field]) => field in body);
  if (values.length === 0) return {};
  const capabilityUpdates: NonNullable<PortalPolicyInput["capabilityUpdates"]> = {};
  for (const [field, capability] of values) {
    const value = body[field];
    if (value === "show" || value === "hide" || value === "default") capabilityUpdates[capability] = value;
  }
  return { capabilityUpdates };
}

/** Merge named form controls only after locking the existing relationship. */
export function mergePortalPolicyInput(
  input: PortalPolicyInput,
  current?: StoredPortalPolicy,
): { capabilityGrants: string[]; capabilityDenials: string[] } | null {
  const grants = input.capabilityGrants ?? current?.capability_grants ?? [];
  const denials = input.capabilityDenials ?? current?.capability_denials ?? [];
  if (!Array.isArray(grants) || !Array.isArray(denials)
    || [...grants, ...denials].some((value) => typeof value !== "string")) return null;
  const updates = input.capabilityUpdates;
  if (updates !== undefined && (!updates || typeof updates !== "object" || Array.isArray(updates))) return null;
  const nextGrants = new Set(grants);
  const nextDenials = new Set(denials);
  for (const [capability, value] of Object.entries(updates ?? {})) {
    if (!isPortalCapability(capability) || !["show", "hide", "default"].includes(value)) return null;
    nextGrants.delete(capability);
    nextDenials.delete(capability);
    if (value === "show") nextGrants.add(capability);
    if (value === "hide") nextDenials.add(capability);
  }
  return { capabilityGrants: [...nextGrants], capabilityDenials: [...nextDenials] };
}
