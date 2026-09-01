import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/settings/user-access-admin.tsx", "utf8");
const settingsPage = readFileSync("src/app/(app)/settings/page.tsx", "utf8");

describe("one-step account setup", () => {
  it("keeps account actions busy until refreshed user data is on screen", () => {
    expect(source).toContain("const actionBusy = busy || refreshing");
    expect(source).toContain("startRefresh(() => router.refresh())");
    expect(source).toContain('aria-busy={actionBusy && busyAction === "create"}');
    expect(source).toContain('busyAction === `toggle:${u.id}`');
    expect(source).toContain('busyAction === `password:${u.id}`');
    expect(source).toContain('busyAction === `access:${u.id}`');
  });

  it("keeps Office manager with the everyday agency-team roles", () => {
    const agencyTeamStart = source.indexOf('<optgroup label="Agency team">');
    const portalsStart = source.indexOf('<optgroup label="Portals">', agencyTeamStart);
    const advancedStart = source.indexOf('<optgroup label="Advanced">', portalsStart);
    const advancedEnd = source.indexOf("</optgroup>", advancedStart);
    const agencyTeamOptions = source.slice(agencyTeamStart, portalsStart);
    const advancedOptions = source.slice(advancedStart, advancedEnd);

    expect(agencyTeamOptions).toContain('"manager"');
    expect(advancedOptions).not.toContain('profile.id === "manager"');
  });

  it("submits a server-owned preset instead of browser-composed permissions", () => {
    expect(source).toContain("if (isAccountPresetId(addProfile))");
    expect(source).toContain("body = { ...form, password, preset: addProfile }");
    const presetBranch = source.match(/if \(isAccountPresetId\(addProfile\)\) \{[\s\S]*?\n      \} else \{/u)?.[0] ?? "";
    expect(presetBranch).toContain("preset: addProfile");
    expect(presetBranch).not.toContain("accessToBody");
  });

  it("shows only the connection required by each portal kind", () => {
    expect(source).toContain('addBinding === "individual"');
    expect(source).toContain("individualId: addIndividualId, relationship: addRelationship");
    expect(source).toContain('addBinding === "employee"');
    expect(source).toContain("employeeId: addEmployeeId");
    expect(source).toContain('addBinding === "agency"');
    expect(source).toContain("agencyId: addAgencyId");
    expect(settingsPage).toContain("listAgencies(pool)");
    expect(settingsPage).toContain("agencies={result.data.agencies}");
  });

  it("keeps external portal connections out of the internal permission editor", () => {
    expect(source).toContain("if (u.portalManaged)");
    expect(source).toContain("const portalAccount = u.portalManaged");
    expect(source).toContain('href="/settings/agencies"');
    expect(source).toContain("Manage portal connections");
    expect(settingsPage).toContain("portalManaged: u.portalManaged");
  });

  it("validates an optional password before submitting an access change", () => {
    expect(source).toContain("newPassword.trim().length > 0 && newPassword.trim().length < 10");
    expect(source).toContain("Enter a temporary password of at least 10 characters.");
  });
});
