import { describe, expect, it } from "vitest";
import { mergePortalPolicyInput, portalPolicyFromInput } from "@/lib/auth/portal-policy-input";
import { PORTAL_CAPABILITIES, portalCapabilitiesForRole, portalCapabilityAllowedForRole } from "@/lib/auth/portal-access";

describe("portal visibility form updates", () => {
  const saved = {
    capability_grants: ["financials.self.billed_totals.read"],
    capability_denials: ["schedules.self.read", "documents.self.read"],
  };

  it.each(["self", "agency"] as const)("maps Approved documents in %s forms without replacing unrelated controls", (scope) => {
    const input = portalPolicyFromInput({ approvedDocuments: "show" }, scope);
    expect(input).toEqual({ capabilityUpdates: { "documents.self.read": "show" } });
    expect(mergePortalPolicyInput(input, saved)).toEqual({
      capabilityGrants: ["financials.self.billed_totals.read", "documents.self.read"],
      capabilityDenials: ["schedules.self.read"],
    });
  });

  it("hides documents and retains grants that an older form does not submit", () => {
    const current = { capability_grants: ["documents.self.read"], capability_denials: ["schedules.self.read"] };
    expect(mergePortalPolicyInput(portalPolicyFromInput({ billedTotals: "show" }, "self"), current)).toEqual({
      capabilityGrants: ["documents.self.read", "financials.self.billed_totals.read"],
      capabilityDenials: ["schedules.self.read"],
    });
    expect(mergePortalPolicyInput(portalPolicyFromInput({ approvedDocuments: "hide" }, "self"), current)).toEqual({
      capabilityGrants: [], capabilityDenials: ["schedules.self.read", "documents.self.read"],
    });
  });

  it("removes only the selected override for Role default and preserves omitted state updates", () => {
    expect(mergePortalPolicyInput(portalPolicyFromInput({ approvedDocuments: "default" }, "self"), saved)).toEqual({
      capabilityGrants: saved.capability_grants, capabilityDenials: ["schedules.self.read"],
    });
    expect(mergePortalPolicyInput(portalPolicyFromInput({ isActive: false }, "self"), saved)).toEqual({
      capabilityGrants: saved.capability_grants, capabilityDenials: saved.capability_denials,
    });
  });

  it("keeps the explicit-array replacement contract and ignores malformed form controls", () => {
    expect(mergePortalPolicyInput(portalPolicyFromInput({ capabilityGrants: [], capabilityDenials: [] }, "self"), saved)).toEqual({ capabilityGrants: [], capabilityDenials: [] });
    expect(mergePortalPolicyInput(portalPolicyFromInput({ approvedDocuments: "anything" }, "self"), saved)).toEqual({ capabilityGrants: saved.capability_grants, capabilityDenials: saved.capability_denials });
  });

  it.each(["individual", "parent", "employee", "agency", "collector", "scheduler", "staffing_manager"] as const)("keeps approved documents opt-in for %s", (role) => {
    expect(portalCapabilityAllowedForRole(role, "documents.self.read")).toBe(true);
    expect(portalCapabilitiesForRole(role)).not.toContain("documents.self.read");
  });

  it.each(["scheduler", "staffing_manager"] as const)("cannot grant financial categories to %s with approved documents", (role) => {
    const financial = PORTAL_CAPABILITIES.filter((capability) => /^(dollar_budgets\.|transactions\.|employee_|financials\.|settlements\.)/.test(capability));
    for (const capability of financial) expect(portalCapabilityAllowedForRole(role, capability), capability).toBe(false);
  });
});
