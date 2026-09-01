import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspace = readFileSync("src/components/schedule/planning-workspace.tsx", "utf8");
const calendar = readFileSync("src/components/schedule/calendar.tsx", "utf8");
const schedules = readFileSync("src/components/schedule/service-schedules.tsx", "utf8");
const createModal = readFileSync("src/components/schedule/create-session-modal.tsx", "utf8");
const editModal = readFileSync("src/components/schedule/edit-service-schedule-modal.tsx", "utf8");

describe("staffing-only schedule language", () => {
  it("propagates the budget boundary into every shared scheduling surface", () => {
    expect(workspace).toContain("showBudgetTracking={showBudgetTracking}");
    expect(calendar).toContain("showBudgetTracking={showBudgetTracking}");
    expect(schedules).toContain("showBudgetTracking = true");
    expect(createModal).toContain("showBudgetTracking = true");
    expect(editModal).toContain("showBudgetTracking = true");
  });

  it("uses schedule-only wording when budget tracking is hidden", () => {
    expect(schedules).toContain('showBudgetTracking ? "Budget readiness" : "Schedule readiness"');
    expect(schedules).toContain('showBudgetTracking ? <option value="over_budget">Over budget</option> : null');
    expect(createModal).toContain('"No schedule or assignment conflicts detected."');
    expect(editModal).toContain('"Complete the schedule details to check assignments and conflicts."');
  });

  it("keeps operational preflight visible when recurring budget forecasts are hidden", () => {
    expect(createModal).toContain("{preview ? (");
    expect(createModal).toContain("<SchedulePreflightSummary");
    expect(createModal).toContain("showBudgetTracking={showBudgetTracking}");
    expect(createModal).not.toContain("preview && (!recurring || (seriesAuthorization");
  });
});
