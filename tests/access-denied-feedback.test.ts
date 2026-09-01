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
});
