import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { individualProfileMainAction } from "@/lib/data/individual-profile";

const page = readFileSync("src/app/(app)/individuals/[id]/page.tsx", "utf8");
const profileData = readFileSync("src/lib/data/individual-profile.ts", "utf8");
const individualId = "20000000-0000-4000-8000-000000000001";

function action(overrides: Partial<Parameters<typeof individualProfileMainAction>[0]> = {}) {
  return individualProfileMainAction({
    individualId,
    status: "active",
    canManage: true,
    canViewBudget: true,
    canPlan: true,
    hasBudget: true,
    missingRenewal: false,
    hoursAfterScheduled: 20,
    assignmentCount: 1,
    remainingReserve: "0",
    ...overrides,
  });
}

describe("individual 360 profile", () => {
  it("uses the five plain profile tabs and real server-authorized portal preview", () => {
    for (const label of ["Overview", "Budgets", "Activity & Schedule", "Money", "More"]) {
      expect(page).toContain(`label: "${label}"`);
    }
    expect(page).toContain('action="/api/auth/impersonation/start"');
    expect(page).toContain('name="targetUserId"');
    expect(page).toContain("Preview this person&apos;s portal");
    expect(page).toContain('user.role === "admin"');
  });

  it("surfaces the requested headline and distinguishes worker facts", () => {
    for (const label of [
      "Budget status",
      "Current renewal",
      "Authorized",
      "Actual used",
      "Future scheduled",
      "Remaining after schedule",
      "Assigned staffing",
      "Agency responsibility",
      "Outstanding put-away",
      "Next scheduled visit",
      "Actual workers",
      "Assigned employees",
      "Scheduled next",
    ]) {
      expect(page).toContain(label);
    }
  });

  it("chooses one deterministic next action in operational priority order", () => {
    expect(action({ hasBudget: false }).label).toBe("Set up budget");
    expect(action({ missingRenewal: true }).label).toBe("Add renewal date");
    expect(action({ hoursAfterScheduled: "-2.5" })).toMatchObject({
      label: "Adjust schedule",
      tone: "danger",
      href: `/schedule?view=calendar&individualId=${individualId}`,
    });
    expect(action({ assignmentCount: 0 }).label).toBe("Assign an employee");
    expect(action({ remainingReserve: "25.00" }).label).toBe("Record put-away");
    expect(action()).toMatchObject({ label: "Review activity", tone: "neutral" });
  });

  it("does not send restricted viewers to hidden budget or schedule workspaces", () => {
    expect(action({ canViewBudget: false, hasBudget: false })).toMatchObject({
      label: "Review activity",
      href: `/individuals/${individualId}?view=activity`,
    });
    expect(action({ canPlan: false, hoursAfterScheduled: "-2.5" })).toMatchObject({
      label: "Review budget",
      href: `/individuals/${individualId}?view=budget`,
    });
    expect(action({ canPlan: false, assignmentCount: 0 })).toMatchObject({
      label: "Review staffing",
      href: `/individuals/${individualId}?view=activity`,
    });
    expect(page).toContain("canViewSchedule: canPlan");
    expect(page).toContain("renewal={canSeeBudgets ?");
    expect(page).toContain("programNames={canSeeBudgets");
    expect(profileData).toContain("options.canViewSchedule");
    expect(profileData).toContain("FROM user_portal_roles portal_role");
  });
});
