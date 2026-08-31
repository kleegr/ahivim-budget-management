import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/settings/user-access-admin.tsx", "utf8");
const settingsPage = readFileSync("src/app/(app)/settings/page.tsx", "utf8");

describe("one-step account setup", () => {
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
