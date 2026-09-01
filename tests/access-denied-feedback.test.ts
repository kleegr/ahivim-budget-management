import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("restricted-route recovery", () => {
  it("carries denied state to the allowed workspace and explains the redirect", () => {
    const home = readFileSync("src/app/(app)/home/page.tsx", "utf8");
    const layout = readFileSync("src/app/(app)/layout.tsx", "utf8");
    const dashboard = readFileSync("src/app/(app)/dashboard/page.tsx", "utf8");
    const ownerDashboard = readFileSync("src/components/dashboard/owner-dashboard.tsx", "utf8");
    const notice = readFileSync("src/components/auth/access-notice.tsx", "utf8");

    expect(home).toContain("withDeniedNotice(viewerHomePath(access, portal), denied)");
    expect(layout).toContain("<AccessNotice />");
    expect(notice).toContain('useSearchParams().get("denied") === "1"');
    expect(notice).toContain("not included in this account");
    expect(dashboard).not.toContain("That page is not part of your access");
    expect(ownerDashboard).not.toContain("That page is not part of your access");
  });

  it("returns restricted agency pages to each user's own role workspace", () => {
    const agencyRoutes = [
      "src/app/(app)/settings/agencies/page.tsx",
      "src/app/(app)/agencies/page.tsx",
      "src/app/(app)/agencies/[id]/page.tsx",
    ].map((path) => readFileSync(path, "utf8"));

    for (const route of agencyRoutes) {
      expect(route).toContain('redirect("/home?denied=1")');
      expect(route).not.toContain('redirect("/portal?denied=1")');
    }
  });
});
