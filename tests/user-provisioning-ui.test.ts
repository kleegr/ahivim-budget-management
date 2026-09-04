import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCOUNT_PRESET_IDS } from "@/lib/auth/account-presets";

const source = readFileSync("src/components/settings/user-access-admin.tsx", "utf8");
const settingsPage = readFileSync("src/app/(app)/settings/page.tsx", "utf8");

describe("one-step account setup", () => {
  it("offers all thirteen canonical account presets", () => {
    for (const preset of ACCOUNT_PRESET_IDS) expect(source, preset).toContain(`"${preset}"`);
    expect(ACCOUNT_PRESET_IDS).toHaveLength(13);
    expect(ACCOUNT_PRESET_IDS).toContain("office_manager");
    expect(ACCOUNT_PRESET_IDS).toContain("custom_access");
  });

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

    expect(agencyTeamOptions).toContain('"office_manager"');
    expect(advancedOptions).not.toContain('profile.id === "office_manager"');
  });

  it("submits the canonical preset plus explicit safe adjustments", () => {
    expect(source).toContain("const preset = getAccountPreset(addProfile)!");
    expect(source).toContain("const body: Record<string, unknown> = { ...form, password, preset: addProfile }");
    expect(source).toContain("internalAccess: accessToBody(addAccess)");
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

  it("reviews the selected preset in the create flow before submission", () => {
    const start = source.indexOf('<form onSubmit={onCreate}');
    const end = source.indexOf("</form>", start);
    const createForm = source.slice(start, end);

    expect(source).toContain("ROLE_PREVIEW_DETAILS");
    expect(createForm).toContain("Main home");
    expect(createForm).toContain("Visible");
    expect(createForm).toContain("Hidden");
  });

  it("keeps adjustments collapsed but applies them from the chosen preset", () => {
    const start = source.indexOf('<form onSubmit={onCreate}');
    const end = source.indexOf("</form>", start);
    const createForm = source.slice(start, end);
    const createHandler = source.slice(
      source.indexOf("async function onCreate"),
      source.indexOf("async function savePortalPassword"),
    );

    expect(createForm).toContain("Adjust permissions");
    expect(createForm).toMatch(/Adjust permissions[\s\S]*(?:AccessConfig|capability)/u);
    expect(createHandler).toContain("capabilityGrants");
    expect(createHandler).toContain("capabilityDenials");
    expect(createHandler).toContain("addCapabilityGrants.size > 0");
    expect(createHandler).toContain("addCapabilityDenials.size > 0");
  });

  it("offers immediate real portal preview with the newly-created user id", () => {
    const start = source.indexOf("{createdCredential ? (");
    const end = source.indexOf("{addOpen ? (", start);
    const success = source.slice(start, end);

    expect(source).toMatch(/createdCredential[^\n]*id: string/u);
    expect(success).toContain('action="/api/auth/impersonation/start"');
    expect(success).toContain('name="targetUserId"');
    expect(success).toContain("createdCredential.id");
    expect(success).toMatch(/Preview(?: this)? portal|Preview \/ Sign in as/u);
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
