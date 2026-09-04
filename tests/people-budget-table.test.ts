import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  authorizedHours,
  computePeopleBudgetTotals,
  individualNextAction,
  matchesPeopleStatus,
  matchesProgram,
  matchesRenewal,
  selectedPeopleActualsHref,
  type PeopleBudgetTableRow,
} from "@/components/individuals/people-budget-table";

const tableSource = readFileSync("src/components/individuals/individuals-list.tsx", "utf8");
const pageSource = readFileSync("src/app/(app)/individuals/page.tsx", "utf8");

function row(overrides: Partial<PeopleBudgetTableRow> = {}): PeopleBudgetTableRow {
  return {
    id: "person-1",
    status: "active",
    archived: false,
    programs: ["Com Hab", "Respite"],
    budget: {
      status: "on_pace",
      missingRenewal: false,
      usedHours: 40,
      hoursLeft: 60,
      scheduledHours: 10,
      hoursAfterScheduled: 50,
      daysToRenewal: 120,
      expired: false,
      mustUseWeekly: 4,
    },
    hasCanonicalBudget: true,
    hasBilling: true,
    insightsVisible: true,
    canPlan: true,
    assignedEmployees: [{ id: "employee-1" }],
    nextScheduledService: { date: "2026-09-12" },
    ...overrides,
  };
}

describe("people and budgets working table", () => {
  it("orders the default scan from identity through the exact next action", () => {
    const columnsSource = tableSource.slice(tableSource.indexOf("const columns"));
    const keys = [
      "name",
      "status",
      "programs",
      "authorizationPeriod",
      "renews",
      "authorized",
      "billedHours",
      "scheduled",
      "left",
      "afterScheduled",
      "health",
      "nextAction",
    ];
    const positions = keys.map((key) => columnsSource.indexOf(`key: "${key}"`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("derives authorized hours from existing actual and remaining facts", () => {
    expect(authorizedHours({ usedHours: 40, hoursLeft: 60 })).toBe("100");
    expect(authorizedHours({ usedHours: 40, hoursLeft: null })).toBeNull();
  });

  it("keeps filtered and selected totals decimal-safe and ignores redacted budgets", () => {
    const totals = computePeopleBudgetTotals([
      row({ id: "person-1" }),
      row({
        id: "person-2",
        budget: {
          ...row().budget!,
          usedHours: 0.1,
          hoursLeft: 0.2,
          scheduledHours: 0.3,
          hoursAfterScheduled: -0.1,
        },
      }),
      row({ id: "redacted", budget: null, insightsVisible: false }),
    ]);

    expect(totals).toEqual({
      people: 3,
      budgetPeople: 2,
      authorizedHours: "100.3",
      usedHours: "40.1",
      scheduledHours: "10.3",
      remainingAfterScheduledHours: "49.9",
    });
  });

  it("surfaces selection, saved views, and exact filtered exports", () => {
    expect(tableSource).toContain("Select all people in the current filters");
    expect(tableSource).toContain("selected · exports use this selection");
    expect(tableSource).toContain('exportEndpoint="/api/grid/export"');
    expect(tableSource).toContain("externalConfig");
    expect(pageSource).toContain("canManage={canEdit}");
    expect(tableSource).toContain("Open recorded activity");
    expect(tableSource).toContain("Work next:");
  });

  it("builds one stable exact-people Activity drill-through", () => {
    expect(selectedPeopleActualsHref(["person-b", "person-a", "person-b"])).toBe(
      "/transactions?individualId=person-a&individualId=person-b",
    );
  });

  it("filters status, exact program membership, and renewal windows", () => {
    const person = row();
    expect(matchesPeopleStatus(person, "active")).toBe(true);
    expect(matchesPeopleStatus({ ...person, status: "inactive" }, "active")).toBe(false);
    expect(matchesProgram(person, "Respite")).toBe(true);
    expect(matchesProgram(person, "Resp")).toBe(false);
    expect(matchesRenewal({ ...person, budget: { ...person.budget!, daysToRenewal: 45 } }, "next_60")).toBe(true);
    expect(matchesRenewal({ ...person, budget: { ...person.budget!, daysToRenewal: 45 } }, "next_30")).toBe(false);
    expect(matchesRenewal({ ...person, budget: { ...person.budget!, missingRenewal: true } }, "missing")).toBe(true);
  });

  it("returns the concrete highest-priority action", () => {
    expect(individualNextAction(row({ hasCanonicalBudget: false })).label).toBe("Create budget for billed work");
    expect(individualNextAction(row({
      budget: { ...row().budget!, hoursAfterScheduled: -7.5 },
    }))).toMatchObject({ label: "Reduce schedule by 7.5 h", destination: "schedule" });
    expect(individualNextAction(row({
      budget: { ...row().budget!, daysToRenewal: 30 },
    })).label).toBe("Prepare renewal");
    expect(individualNextAction(row()).label).toBe("Plan 4 h/week");
    expect(individualNextAction(row({ assignedEmployees: [] }))).toMatchObject({
      label: "Assign an employee",
      destination: "assignments",
    });
    expect(individualNextAction(row({ nextScheduledService: null }))).toMatchObject({
      label: "Schedule next service",
      destination: "schedule",
    });
    expect(individualNextAction(row({
      canPlan: false,
      budget: { ...row().budget!, hoursAfterScheduled: -7.5 },
    })).destination).toBe("budget");
  });

  it("keeps exception shortcuts and the required staffing columns in the default scan", () => {
    for (const key of ["billingWithoutBudget", "assignedEmployees", "nextScheduledService"]) {
      expect(tableSource).toContain(`key: "${key}"`);
    }
    for (const label of ["Billing, no budget", "Renewal missing", "Renewal overdue", "Schedule over", "Behind pace"]) {
      expect(tableSource).toContain(label);
    }
    expect(tableSource).toContain('useState<PeopleStatusFilter>("all")');
  });

  it("does not infer budget problems from redacted rows", () => {
    const action = individualNextAction(row({
      budget: null,
      hasCanonicalBudget: false,
      hasBilling: false,
      insightsVisible: false,
    }));
    expect(action).toEqual({ label: "Open individual", destination: "profile", tone: "muted" });
    expect(matchesRenewal(row({ budget: null, insightsVisible: false }), "missing")).toBe(false);
  });
});
