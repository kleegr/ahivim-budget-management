import { describe, expect, it, vi } from "vitest";
import { listEmployeeAvailability } from "@/lib/data/employee-availability";
import type { PgLikePool } from "@/lib/import/commit";

const PROGRAM_ID = "10000000-0000-0000-0000-000000000001";
const INDIVIDUAL_IDS = [
  "20000000-0000-0000-0000-000000000001",
  "20000000-0000-0000-0000-000000000002",
];
const EMPLOYEE_IDS = {
  alice: "30000000-0000-0000-0000-000000000001",
  bob: "30000000-0000-0000-0000-000000000002",
  cara: "30000000-0000-0000-0000-000000000003",
  dana: "30000000-0000-0000-0000-000000000004",
};

describe("employee planning availability", () => {
  it("ranks employees across every occurrence without selecting financial data", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM employees")) {
        return {
          rows: [
            { employee_id: EMPLOYEE_IDS.alice, employee_name: "Alice" },
            { employee_id: EMPLOYEE_IDS.bob, employee_name: "Bob" },
            { employee_id: EMPLOYEE_IDS.cara, employee_name: "Cara" },
            { employee_id: EMPLOYEE_IDS.dana, employee_name: "Dana" },
          ],
        };
      }
      if (sql.includes("FROM assignments")) {
        return {
          rows: [
            ...[EMPLOYEE_IDS.alice, EMPLOYEE_IDS.bob, EMPLOYEE_IDS.dana].flatMap((employee_id) =>
              INDIVIDUAL_IDS.map((individual_id) => ({ employee_id, individual_id, start_date: null, end_date: null }))),
            ...INDIVIDUAL_IDS.map((individual_id) => ({
              employee_id: EMPLOYEE_IDS.cara,
              individual_id,
              start_date: null,
              end_date: "2026-08-24",
            })),
          ],
        };
      }
      if (sql.includes("AS fact_type")) {
        return {
          rows: [
            {
              fact_type: "weekly",
              employee_id: EMPLOYEE_IDS.alice,
              session_date: null,
              weekday: 1,
              start_time: "09:00",
              end_time: "12:00",
              effective_from: "2026-01-01",
              effective_to: null,
              start_date: null,
              end_date: null,
            },
            ...[
              { employee_id: EMPLOYEE_IDS.bob, session_date: "2026-08-24", start_time: "10:00", end_time: "11:00" },
              { employee_id: EMPLOYEE_IDS.bob, session_date: "2026-08-24", start_time: "09:45", end_time: "10:15" },
              { employee_id: EMPLOYEE_IDS.bob, session_date: "2026-08-31", start_time: "12:00", end_time: "13:00" },
              { employee_id: EMPLOYEE_IDS.dana, session_date: "2026-08-31", start_time: null, end_time: null },
            ].map((row) => ({
              ...row,
              fact_type: "conflict",
              weekday: null,
              effective_from: null,
              effective_to: null,
              start_date: null,
              end_date: null,
            })),
          ],
        };
      }
      return { rows: [] };
    });
    const pool = { query } as unknown as PgLikePool;

    const result = await listEmployeeAvailability(pool, {
      programId: PROGRAM_ID,
      individualIds: INDIVIDUAL_IDS,
      sessionDate: "2026-08-24",
      sessionDates: ["2026-08-24", "2026-08-31"],
      startTime: "09:30",
      endTime: "10:30",
    });

    expect(result.timeRangeKnown).toBe(true);
    expect(result.occurrenceCount).toBe(2);
    expect(result.employees).toEqual([
      {
        employeeId: EMPLOYEE_IDS.alice, employeeName: "Alice", assignedToAll: true,
        assignedOccurrenceCount: 2, conflictCount: 0, conflictingOccurrenceCount: 0,
        withinDeclaredAvailabilityOccurrenceCount: 2,
        outsideDeclaredAvailabilityOccurrenceCount: 0,
        undeclaredAvailabilityOccurrenceCount: 0, unavailableOccurrenceCount: 0,
        reasonCodes: [], available: true,
      },
      {
        employeeId: EMPLOYEE_IDS.bob, employeeName: "Bob", assignedToAll: true,
        assignedOccurrenceCount: 2, conflictCount: 2, conflictingOccurrenceCount: 1,
        withinDeclaredAvailabilityOccurrenceCount: 0,
        outsideDeclaredAvailabilityOccurrenceCount: 0,
        undeclaredAvailabilityOccurrenceCount: 2, unavailableOccurrenceCount: 0,
        reasonCodes: ["schedule_conflict", "availability_not_declared"], available: false,
      },
      {
        employeeId: EMPLOYEE_IDS.dana, employeeName: "Dana", assignedToAll: true,
        assignedOccurrenceCount: 2, conflictCount: 1, conflictingOccurrenceCount: 1,
        withinDeclaredAvailabilityOccurrenceCount: 0,
        outsideDeclaredAvailabilityOccurrenceCount: 0,
        undeclaredAvailabilityOccurrenceCount: 2, unavailableOccurrenceCount: 0,
        reasonCodes: ["schedule_conflict", "availability_not_declared"], available: false,
      },
      {
        employeeId: EMPLOYEE_IDS.cara, employeeName: "Cara", assignedToAll: false,
        assignedOccurrenceCount: 1, conflictCount: 0, conflictingOccurrenceCount: 0,
        withinDeclaredAvailabilityOccurrenceCount: 0,
        outsideDeclaredAvailabilityOccurrenceCount: 0,
        undeclaredAvailabilityOccurrenceCount: 2, unavailableOccurrenceCount: 0,
        reasonCodes: ["not_assigned", "availability_not_declared"], available: false,
      },
    ]);
    expect(JSON.stringify(result).toLowerCase()).not.toMatch(/rate|amount|transaction|check|payout|dollar/);

    const sql = query.mock.calls.map(([statement]) => statement).join("\n").toLowerCase();
    for (const forbidden of ["expected_", "rate", "amount", "transaction", "check", "payout"]) {
      expect(sql).not.toContain(forbidden);
    }
    expect(sql).toContain("status in ('pending', 'completed')");
  });

  it("does not claim availability or query conflicts without a valid time range", async () => {
    const query = vi.fn(async (sql: string) => sql.includes("FROM employees")
      ? { rows: [{ employee_id: EMPLOYEE_IDS.alice, employee_name: "Alice" }] }
      : {
        rows: INDIVIDUAL_IDS.map((individual_id) => ({
          employee_id: EMPLOYEE_IDS.alice,
          individual_id,
          start_date: null,
          end_date: null,
        })),
      });
    const pool = { query } as unknown as PgLikePool;

    const result = await listEmployeeAvailability(pool, {
      programId: PROGRAM_ID,
      individualIds: INDIVIDUAL_IDS,
      sessionDate: "2026-08-24",
      startTime: null,
      endTime: null,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      timeRangeKnown: false,
      occurrenceCount: 1,
      employees: [{
        employeeId: EMPLOYEE_IDS.alice,
        employeeName: "Alice",
        assignedToAll: true,
        assignedOccurrenceCount: 1,
        conflictCount: 0,
        conflictingOccurrenceCount: 0,
        withinDeclaredAvailabilityOccurrenceCount: 0,
        outsideDeclaredAvailabilityOccurrenceCount: 0,
        undeclaredAvailabilityOccurrenceCount: 0,
        unavailableOccurrenceCount: 0,
        reasonCodes: ["time_range_required"],
        available: false,
      }],
    });
  });

  it("applies recurring hours and dated unavailability across every visit", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM employees")) {
        return {
          rows: [
            { employee_id: EMPLOYEE_IDS.alice, employee_name: "Alice" },
            { employee_id: EMPLOYEE_IDS.bob, employee_name: "Bob" },
            { employee_id: EMPLOYEE_IDS.cara, employee_name: "Cara" },
            { employee_id: EMPLOYEE_IDS.dana, employee_name: "Dana" },
          ],
        };
      }
      if (sql.includes("FROM assignments")) {
        return {
          rows: Object.values(EMPLOYEE_IDS).flatMap((employee_id) =>
            INDIVIDUAL_IDS.map((individual_id) => ({
              employee_id,
              individual_id,
              start_date: null,
              end_date: null,
            }))),
        };
      }
      if (sql.includes("AS fact_type")) {
        return {
          rows: [
            ...[
              { employee_id: EMPLOYEE_IDS.alice, weekday: 1, start_time: "09:00", end_time: "10:00", effective_from: "2026-01-01", effective_to: null },
              { employee_id: EMPLOYEE_IDS.bob, weekday: 1, start_time: "10:00", end_time: "12:00", effective_from: "2026-01-01", effective_to: null },
              { employee_id: EMPLOYEE_IDS.cara, weekday: 1, start_time: "09:00", end_time: "12:00", effective_from: "2026-01-01", effective_to: null },
            ].map((row) => ({
              ...row,
              fact_type: "weekly",
              session_date: null,
              start_date: null,
              end_date: null,
            })),
            ...[
              { employee_id: EMPLOYEE_IDS.alice, start_date: "2026-08-24", end_date: "2026-08-24", start_time: "10:00", end_time: "11:00" },
              { employee_id: EMPLOYEE_IDS.cara, start_date: "2026-08-31", end_date: "2026-08-31", start_time: null, end_time: null },
            ].map((row) => ({
              ...row,
              fact_type: "unavailable",
              session_date: null,
              weekday: null,
              effective_from: null,
              effective_to: null,
            })),
          ],
        };
      }
      return { rows: [] };
    });
    const pool = { query } as unknown as PgLikePool;

    const result = await listEmployeeAvailability(pool, {
      programId: PROGRAM_ID,
      individualIds: INDIVIDUAL_IDS,
      sessionDate: "2026-08-24",
      sessionDates: ["2026-08-24", "2026-08-31"],
      startTime: "09:00",
      endTime: "10:00",
    });

    expect(result.employees.map((employee) => employee.employeeId)).toEqual([
      EMPLOYEE_IDS.alice,
      EMPLOYEE_IDS.dana,
      EMPLOYEE_IDS.bob,
      EMPLOYEE_IDS.cara,
    ]);
    expect(result.employees[0]).toMatchObject({
      available: true,
      withinDeclaredAvailabilityOccurrenceCount: 2,
      unavailableOccurrenceCount: 0,
      reasonCodes: [],
    });
    expect(result.employees[1]).toMatchObject({
      available: true,
      undeclaredAvailabilityOccurrenceCount: 2,
      reasonCodes: ["availability_not_declared"],
    });
    expect(result.employees[2]).toMatchObject({
      available: false,
      outsideDeclaredAvailabilityOccurrenceCount: 2,
      reasonCodes: ["outside_declared_availability"],
    });
    expect(result.employees[3]).toMatchObject({
      available: false,
      unavailableOccurrenceCount: 1,
      reasonCodes: ["dated_unavailability"],
    });
  });

  it("returns no roster for malformed identifiers", async () => {
    const query = vi.fn();
    const pool = { query } as unknown as PgLikePool;

    const result = await listEmployeeAvailability(pool, {
      programId: PROGRAM_ID,
      individualIds: ["not-a-uuid"],
      sessionDate: "2026-08-24",
      startTime: "09:00",
      endTime: "10:00",
    });

    expect(query).not.toHaveBeenCalled();
    expect(result.employees).toEqual([]);
  });

  it("serializes availability reads for a transaction-backed queryable", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const query = vi.fn(async (sql: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      try {
        if (sql.includes("FROM employees")) {
          return { rows: [{ employee_id: EMPLOYEE_IDS.alice, employee_name: "Alice" }] };
        }
        if (sql.includes("FROM assignments")) {
          return {
            rows: INDIVIDUAL_IDS.map((individual_id) => ({
              employee_id: EMPLOYEE_IDS.alice,
              individual_id,
              start_date: null,
              end_date: null,
            })),
          };
        }
        return { rows: [] };
      } finally {
        inFlight -= 1;
      }
    });
    const pool = { query } as unknown as PgLikePool;

    await listEmployeeAvailability(pool, {
      programId: PROGRAM_ID,
      individualIds: INDIVIDUAL_IDS,
      sessionDate: "2026-08-24",
      startTime: "09:00",
      endTime: "10:00",
    });

    expect(query).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
    const factSql = String(query.mock.calls[2]?.[0]);
    expect(factSql).toContain("FROM scheduled_sessions");
    expect(factSql).toContain("FROM employee_weekly_availability");
    expect(factSql).toContain("FROM employee_unavailability");
  });
});
