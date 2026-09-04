import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("agency 360 workspace", () => {
  it("uses canonical scoped models without introducing a second financial formula", () => {
    const source = readFileSync("src/lib/data/agency-profile.ts", "utf8");
    expect(source).toContain("getPortalHomeReadModel");
    expect(source).toContain("getPlanningWorkspace");
    expect(source).toContain("filterPlanningWorkspaceForAgency");
    expect(source).toContain("{ agencyIds: [agencyId] }");
    expect(source).not.toContain("getAgencyFinancialReport");
    expect(source).not.toContain("payroll_transactions");
    expect(source).not.toContain("SELECT ");
  });

  it("exposes dated rosters, planning sources, exact financial rows, users, and preview", () => {
    const component = readFileSync("src/components/agencies/agency-profile.tsx", "utf8");
    const route = readFileSync("src/app/(app)/agencies/[id]/page.tsx", "utf8");
    const portal = readFileSync("src/components/portal/portal-home.tsx", "utf8");

    for (const label of [
      "Dated Individual roster",
      "Roster only",
      "Programs and authorizations",
      "Future scheduled",
      "Assignments",
      "Uniquely attributed verified checks",
      "Agency users",
    ]) expect(component).toContain(label);
    expect(component).toContain("sessionId=${item.id}");
    expect(component).toContain("individualId=${row.individualId}");
    expect(route).toContain("canAccessPortalAgency(portal, id)");
    expect(route).toContain("getAgencyProfileReadModel");
    expect(route).toContain('action="/api/auth/impersonation/start"');
    expect(route).toContain("Preview Agency portal");
    expect(portal).toContain("Open Agency 360");
    expect(portal).toContain('return "Roster only"');
  });

  it("keeps linked users and internal person routes owner-only", () => {
    const component = readFileSync("src/components/agencies/agency-profile.tsx", "utf8");
    const route = readFileSync("src/app/(app)/agencies/[id]/page.tsx", "utf8");

    expect(component).toContain("if (profile.linkedUsers === null) return null");
    expect(component).toContain("profile.permissions.isOwner ? <Link href={`/individuals/");
    expect(component).toContain("profile.permissions.isOwner ? <Link href={`/employees/");
    expect(route).toContain("profile?.permissions.isOwner");
  });
});
