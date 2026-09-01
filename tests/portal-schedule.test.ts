import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarSession } from "@/lib/data/schedule-queries";
import type { PgLikePool } from "@/lib/import/commit";

const mocks = vi.hoisted(() => ({ listSessions: vi.fn() }));

vi.mock("@/lib/data/schedule-queries", () => ({
  listSessions: mocks.listSessions,
}));

import {
  employeePortalUpcomingSchedule,
  individualPortalUpcomingSchedule,
} from "@/lib/data/portal-schedule";

const INDIVIDUAL = "00000000-0000-4000-8000-000000000001";
const EMPLOYEE = "00000000-0000-4000-8000-000000000002";
const pool = { query: vi.fn(), connect: vi.fn() } as unknown as PgLikePool;

function session(overrides: Partial<CalendarSession> = {}): CalendarSession {
  return {
    id: "session-private-id",
    seriesId: "series-private-id",
    sessionDate: "2026-06-04",
    startTime: "09:00:00",
    endTime: "11:00:00",
    durationHours: "2",
    employeeId: EMPLOYEE,
    employeeName: "Assigned Employee",
    programId: "program-private-id",
    programName: "Community Habilitation",
    isGroup: true,
    groupSize: 3,
    individualNames: ["Linked Individual", "Other Group Member"],
    individualIds: [INDIVIDUAL, "other-private-individual-id"],
    status: "pending",
    warningCount: 4,
    canChangeSchedule: true,
    ...overrides,
  };
}

describe("portal-safe upcoming schedules", () => {
  beforeEach(() => mocks.listSessions.mockReset());

  it("shows a parent only the linked person's service facts without employee identity", async () => {
    mocks.listSessions.mockResolvedValue([session()]);

    const schedule = await individualPortalUpcomingSchedule(pool, INDIVIDUAL, "2026-06-01");

    expect(mocks.listSessions).toHaveBeenCalledWith(pool, {
      from: "2026-06-01",
      to: "2026-07-31",
      status: "pending",
      individualId: INDIVIDUAL,
    });
    expect(schedule).toEqual({
      status: "ready",
      from: "2026-06-01",
      through: "2026-07-31",
      items: [{
        audience: "individual",
        sessionDate: "2026-06-04",
        startTime: "09:00:00",
        endTime: "11:00:00",
        durationHours: "2.0000",
        programName: "Community Habilitation",
        isGroup: true,
      }],
    });
    const payload = JSON.stringify(schedule);
    expect(payload).not.toContain("Assigned Employee");
    expect(payload).not.toContain("Other Group Member");
    expect(payload).not.toMatch(/individualIds|employeeId|employeeName|programId|seriesId|warning|amount|rate/i);
  });

  it("shows an employee only the people assigned to that employee's visit", async () => {
    mocks.listSessions.mockResolvedValue([session()]);

    const schedule = await employeePortalUpcomingSchedule(pool, EMPLOYEE, "2026-06-01");

    expect(mocks.listSessions).toHaveBeenCalledWith(pool, {
      from: "2026-06-01",
      to: "2026-07-31",
      status: "pending",
      employeeId: EMPLOYEE,
    });
    expect(schedule.items[0]).toMatchObject({
      audience: "employee",
      individualNames: ["Linked Individual", "Other Group Member"],
    });
    const payload = JSON.stringify(schedule);
    expect(payload).not.toContain("Assigned Employee");
    expect(payload).not.toMatch(/individualIds|employeeId|programId|seriesId|warning|amount|rate/i);
  });

  it("returns simple empty and unavailable states without exposing an error", async () => {
    mocks.listSessions.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("private database detail"));

    await expect(individualPortalUpcomingSchedule(pool, INDIVIDUAL, "2026-06-01")).resolves.toMatchObject({
      status: "ready",
      items: [],
    });
    const unavailable = await employeePortalUpcomingSchedule(pool, EMPLOYEE, "2026-06-01");
    expect(unavailable).toMatchObject({ status: "unavailable", items: [] });
    expect(JSON.stringify(unavailable)).not.toContain("private database detail");
  });
});
