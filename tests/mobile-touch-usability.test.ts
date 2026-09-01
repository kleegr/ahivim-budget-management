import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globals = readFileSync("src/app/globals.css", "utf8");
const sharedUi = readFileSync("src/components/ui.tsx", "utf8");
const individuals = readFileSync("src/components/individuals/individuals-list.tsx", "utf8");
const employees = readFileSync("src/components/employees/employees-list.tsx", "utf8");
const planningEmployees = readFileSync("src/components/employees/planning-employees-list.tsx", "utf8");
const syncConsole = readFileSync("src/components/sync/sync-console.tsx", "utf8");
const signInForm = readFileSync("src/app/signin/signin-form.tsx", "utf8");

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

  it("uses the shared touch-sized primary control for sync and settings actions", () => {
    expect(syncConsole).toMatch(/onClick=\{syncNow\}[\s\S]{0,160}className="btn btn-primary"/);
    expect(syncConsole).toMatch(/type="submit" disabled=\{busy !== null\} className="btn btn-primary"/);
    expect(syncConsole.match(/className="btn btn-primary"/g)).toHaveLength(2);
  });

  it("uses shared touch-sized controls on the sign-in screen", () => {
    expect(signInForm.match(/className="input mt-1 w-full text-sm"/g)).toHaveLength(2);
    expect(signInForm).toContain('className="btn btn-primary w-full"');
    expect(signInForm).toContain("aria-busy={busy}");
  });

  it("gives modal scheduling controls a 44px coarse-pointer target", () => {
    expect(globals).toContain('[role="dialog"] :where(button, select, input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]))');
  });
});
