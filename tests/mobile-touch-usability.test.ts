import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globals = readFileSync("src/app/globals.css", "utf8");
const sharedUi = readFileSync("src/components/ui.tsx", "utf8");
const individuals = readFileSync("src/components/individuals/individuals-list.tsx", "utf8");
const employees = readFileSync("src/components/employees/employees-list.tsx", "utf8");
const planningEmployees = readFileSync("src/components/employees/planning-employees-list.tsx", "utf8");
const syncConsole = readFileSync("src/components/sync/sync-console.tsx", "utf8");

describe("mobile table usability", () => {
  it("gives table links and buttons a 44px target only below the mobile breakpoint", () => {
    const mobileRule = globals.indexOf("@media (max-width: 767px)");
    const tableTarget = globals.indexOf(".touch-table :where(a[href], button)");
    expect(mobileRule).toBeGreaterThanOrEqual(0);
    expect(tableTarget).toBeGreaterThan(mobileRule);
    expect(globals).toContain("min-height: 2.75rem");
  });

  it("opts the core people, staffing, schedule, and sync tables into larger mobile targets", () => {
    expect(sharedUi).toContain('className="touch-table relative min-w-full');
    expect(individuals).toContain('className="touch-table w-full');
    expect(employees).toContain('className="touch-table w-full');
    expect(planningEmployees).toContain('className="touch-table w-full');
    expect(syncConsole).toContain('className="touch-table relative w-full');
  });

  it("positions wide tables so screen-reader-only headers stay inside their scroller", () => {
    expect(sharedUi).toContain('className="touch-table relative min-w-full');
    expect(syncConsole).toContain('className="touch-table relative w-full');
    expect(syncConsole).toContain('<span className="sr-only">Open</span>');
  });
});
