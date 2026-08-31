import { describe, expect, it } from "vitest";
import {
  ACCOUNT_PRESETS,
  ACCOUNT_PRESET_IDS,
  getAccountPreset,
  PORTAL_ONLY_ACCESS,
} from "@/lib/auth/account-presets";

describe("account presets", () => {
  it("defines every supported role exactly once", () => {
    expect(ACCOUNT_PRESETS.map((preset) => preset.id)).toEqual(ACCOUNT_PRESET_IDS);
    expect(new Set(ACCOUNT_PRESETS.map((preset) => preset.id)).size).toBe(11);
  });

  it("keeps every external portal preset outside internal application access", () => {
    for (const id of [
      "individual_parent",
      "employee",
      "agency",
      "agency_scheduler",
      "agency_staffing_manager",
      "agency_collector",
    ] as const) {
      expect(getAccountPreset(id)).toMatchObject({ role: "viewer", access: PORTAL_ONLY_ACCESS });
    }
  });

  it("maps the agency presets to their exact scoped portal roles", () => {
    expect(getAccountPreset("agency")?.binding).toEqual({ kind: "agency", role: "agency" });
    expect(getAccountPreset("agency_scheduler")?.binding).toEqual({ kind: "agency", role: "scheduler" });
    expect(getAccountPreset("agency_staffing_manager")?.binding).toEqual({ kind: "agency", role: "staffing_manager" });
    expect(getAccountPreset("agency_collector")?.binding).toEqual({ kind: "agency", role: "collector" });
  });

  it("makes Owner both an administrator and a portal owner binding", () => {
    expect(getAccountPreset("owner")).toMatchObject({
      role: "admin",
      binding: { kind: "owner" },
    });
  });

  it("defaults individual portals to aggregate billed and set-aside categories only", () => {
    expect(getAccountPreset("individual_parent")?.binding).toEqual({
      kind: "individual",
      defaultCapabilityGrants: [
        "financials.self.billed_totals.read",
        "financials.self.cuts_set_asides.read",
      ],
    });
  });
});
