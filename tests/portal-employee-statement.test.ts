import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/portal/portal-home.tsx", "utf8");
const readModel = readFileSync("src/lib/data/portal-direct-read-model.ts", "utf8");

describe("external portal role experience", () => {
  it("turns the employee landing page into a direct-pay statement", () => {
    for (const copy of [
      "My direct-pay statement",
      "Available credit",
      "Give-back",
      "You keep",
      "Recent give-back activity",
      "Payments, credits, adjustments, and reversals recorded on your balance.",
    ]) {
      expect(source).toContain(copy);
    }
  });

  it("shows keep amounts only when the safe read model supplies them", () => {
    expect(source).toContain("showCheckSettlement");
    expect(source).toContain("check.giveBackDue === undefined");
    expect(source).toContain("check.employeeKeeps === undefined");
    expect(readModel).toContain("const finalKeepIds = netIds.filter");
    expect(readModel).toContain("directPayIds.includes(id) && giveBackIds.includes(id)");
    expect(readModel).toContain("calculateDirectEmployeeCheck({");
    expect(readModel).toContain("item.employeeKeeps = direct.employeeKeeps");
  });

  it("does not query deal terms when final-keep visibility is unavailable", () => {
    expect(readModel).toContain("const dealProjection = finalKeepIds.length > 0");
    expect(readModel).toContain("const dealJoin = finalKeepIds.length > 0");
    expect(readModel).toContain("FROM employee_deals employee_deal");
    expect(readModel).toContain("employee_deal.effective_from <= canonical_service_date(");
  });

  it("gives agency schedulers and staffing managers a direct scheduling action", () => {
    expect(source).toContain('agencyRoles.has("scheduler") || agencyRoles.has("staffing_manager")');
    expect(source).toContain('href="/schedule"');
    expect(source).toContain("Open scheduling");
    expect(source).toContain("dated roster and hour coverage");
  });
});
