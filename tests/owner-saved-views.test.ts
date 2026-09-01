import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeOwnerViewConfig, ownerViewHref } from "@/lib/dashboard/owner-views";

describe("owner saved activity views", () => {
  it("restores every dashboard filter and repeated person selection", () => {
    const href = ownerViewHref({
      checkDateFrom: "2026-08-01",
      checkDateTo: "2026-08-31",
      individualIds: ["person-a", "person-b"],
      employeeId: "employee-a",
      payrollPeriod: "August payroll",
    });

    const url = new URL(href!, "http://localhost");
    expect(url.pathname).toBe("/dashboard");
    expect(url.searchParams.get("from")).toBe("2026-08-01");
    expect(url.searchParams.getAll("individualId")).toEqual(["person-a", "person-b"]);
    expect(url.searchParams.get("employeeId")).toBe("employee-a");
    expect(url.searchParams.get("payrollPeriod")).toBe("August payroll");
  });

  it("sanitizes malformed opaque view configuration before building a link", () => {
    expect(normalizeOwnerViewConfig(null)).toBeNull();
    expect(normalizeOwnerViewConfig({
      individualIds: [" person-a ", "person-a", 42, ""],
      employeeId: 123,
    })).toMatchObject({
      individualIds: ["person-a"],
      employeeId: null,
    });
  });

  it("loads owner views with the owner dashboard data and preserves first-click feedback", () => {
    const page = readFileSync("src/app/(app)/dashboard/page.tsx", "utf8");
    const component = readFileSync("src/components/dashboard/owner-saved-views.tsx", "utf8");

    expect(page).toContain('listGridViews(pool, "owner_dashboard")');
    expect(component).toContain('gridKey: "owner_dashboard"');
    expect(component).toContain('aria-busy={busy === "save"}');
    expect(component).toContain("Nothing was changed.");
  });
});
