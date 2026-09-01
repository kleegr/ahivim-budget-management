import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/portal/portal-home.tsx", "utf8");
const fullPage = readFileSync("src/app/(app)/portal/schedule/page.tsx", "utf8");
const scheduleStart = source.indexOf("function UpcomingSchedule");
const scheduleEnd = source.indexOf("function SummaryGrid", scheduleStart);
const scheduleUi = source.slice(scheduleStart, scheduleEnd);

describe("portal upcoming schedule UI", () => {
  it("places the same simple schedule section on individual and employee portals", () => {
    expect(source).toContain("schedule={individual.upcomingSchedule}");
    expect(source).toContain("schedule={employee.upcomingSchedule}");
    expect(scheduleUi).toContain("Upcoming schedule");
    expect(scheduleUi).toContain("No upcoming visits scheduled");
    expect(scheduleUi).toContain("Refresh this page to try again.");
  });

  it("keeps the portal summary to five visits with an honest scoped full-schedule link", () => {
    expect(scheduleUi).toContain("summaryLimit = 5");
    expect(scheduleUi).toContain("schedule.items.slice(0, summaryLimit)");
    expect(scheduleUi).toContain("Showing {visibleItems.length} of {schedule.items.length} upcoming visits");
    expect(scheduleUi).toContain("View full schedule");
    expect(source).toContain("/portal/schedule?individualId=${encodeURIComponent(individual.id)}");
    expect(source).toContain("/portal/schedule?employeeId=${encodeURIComponent(employee.id)}");
  });

  it("renders only permitted schedule facts and never exposes an employee to a parent", () => {
    expect(scheduleUi).toContain('item.audience === "individual"');
    expect(scheduleUi).toContain('"Scheduled service"');
    expect(scheduleUi).not.toContain("item.employeeName");
    expect(scheduleUi).toContain("item.individualNames");
    expect(scheduleUi).toContain("item.durationHours");
    expect(scheduleUi).not.toMatch(/<Money|gross|net|tax|amount|rate/i);
  });

  it("keeps the full schedule in the portal and rechecks the exact subject capability", () => {
    expect(fullPage).toContain('hasPortalIndividualCapability(access, individualId, "schedules.self.read")');
    expect(fullPage).toContain('hasPortalEmployeeCapability(access, employeeId!, "schedules.self.read")');
    expect(fullPage).toContain("<UpcomingSchedule schedule={result.data.schedule} summaryLimit={null} />");
    expect(fullPage).not.toMatch(/<Money|gross|net|tax|amount|rate/i);
  });
});
