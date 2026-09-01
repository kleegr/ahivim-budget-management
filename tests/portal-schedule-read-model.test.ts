import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalAccessContext, PortalCapability } from "@/lib/auth/portal-access";
import type { PgLikePool } from "@/lib/import/commit";

const mocks = vi.hoisted(() => ({
  individualSchedule: vi.fn(),
  employeeSchedule: vi.fn(),
}));

vi.mock("@/lib/data/portal-schedule", () => ({
  individualPortalUpcomingSchedule: mocks.individualSchedule,
  employeePortalUpcomingSchedule: mocks.employeeSchedule,
}));

import { getPortalHomeReadModel } from "@/lib/data/portal-read-model";

const INDIVIDUAL = "00000000-0000-4000-8000-000000000001";
const EMPLOYEE = "00000000-0000-4000-8000-000000000002";
const schedule = { status: "ready" as const, from: "2026-06-01", through: "2026-07-31", items: [] };

function directContext(
  kind: "parent" | "employee",
  denials: PortalCapability[] = [],
): PortalAccessContext {
  return {
    userId: "portal-user",
    globalRoles: [{ role: kind, grants: [], denials }],
    agencyAccess: [],
    individualLinks: kind === "parent" ? [{
      individualId: INDIVIDUAL,
      relationship: "guardian",
      grants: [],
      denials: [],
    }] : [],
    employeeLinks: kind === "employee" ? [{
      employeeId: EMPLOYEE,
      relationship: "self",
      grants: [],
      denials: [],
    }] : [],
  };
}

function peopleOnlyPool(): PgLikePool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM individuals")) return { rows: [{ id: INDIVIDUAL, name: "Linked Individual" }] };
    if (sql.includes("FROM employees")) return { rows: [{ id: EMPLOYEE, name: "Linked Employee" }] };
    throw new Error(`Unexpected portal query: ${sql}`);
  });
  return { query, connect: vi.fn() } as unknown as PgLikePool;
}

describe("portal schedule capability boundary", () => {
  beforeEach(() => {
    mocks.individualSchedule.mockReset().mockResolvedValue(schedule);
    mocks.employeeSchedule.mockReset().mockResolvedValue(schedule);
  });

  it("loads schedules only for the directly linked individual and employee", async () => {
    const parent = await getPortalHomeReadModel(
      peopleOnlyPool(),
      directContext("parent", ["hours_budgets.self.read"]),
      "2026-06",
    );
    const employee = await getPortalHomeReadModel(
      peopleOnlyPool(),
      directContext("employee", [
        "employee_pay.self.read",
        "employee_checks.self.gross.read",
        "employee_checks.self.net.read",
        "employee_checks.self.tax.read",
        "employee_giveback.self.read",
      ]),
      "2026-06",
    );

    expect(mocks.individualSchedule).toHaveBeenCalledWith(expect.anything(), INDIVIDUAL);
    expect(mocks.employeeSchedule).toHaveBeenCalledWith(expect.anything(), EMPLOYEE);
    expect(parent.individuals[0]?.upcomingSchedule).toEqual(schedule);
    expect(employee.employees[0]?.upcomingSchedule).toEqual(schedule);
  });

  it("does not query or return a schedule when that subject capability is denied", async () => {
    const model = await getPortalHomeReadModel(
      peopleOnlyPool(),
      directContext("parent", ["hours_budgets.self.read", "schedules.self.read"]),
      "2026-06",
    );

    expect(mocks.individualSchedule).not.toHaveBeenCalled();
    expect(model.individuals[0]?.upcomingSchedule).toBeNull();
  });
});
