import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import {
  evaluateAssignmentAllowedHours,
  projectAssignmentAllowedHours,
  projectSeriesAssignmentAllowedHours,
  type AssignmentAllowedHoursEvaluation,
} from "@/lib/data/assignment-allowed-hours";

const ASSIGNMENT_ID = "10000000-0000-4000-8000-000000000001";
const EMPLOYEE_ID = "20000000-0000-4000-8000-000000000001";
const INDIVIDUAL_ID = "30000000-0000-4000-8000-000000000001";
const PROGRAM_ID = "40000000-0000-4000-8000-000000000001";
const SESSION_ID = "50000000-0000-4000-8000-000000000001";

function evaluation(overrides: Partial<AssignmentAllowedHoursEvaluation> = {}): AssignmentAllowedHoursEvaluation {
  return {
    assignmentId: ASSIGNMENT_ID,
    employeeId: EMPLOYEE_ID,
    employeeName: "Alice Employee",
    individualId: INDIVIDUAL_ID,
    individualName: "Ari Individual",
    programId: PROGRAM_ID,
    programName: "Com Hab",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    allowedHours: "10.0000",
    actualHours: "4.0000",
    scheduledHours: "4.0000",
    remainingHours: "2.0000",
    overLimit: false,
    ...overrides,
  };
}

describe("assignment allowed-hours evaluator", () => {
  it("uses canonical signed actuals, inclusive assignment bounds, agency routing, and pending unmatched schedule", async () => {
    let statement = "";
    let params: unknown[] | undefined;
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        statement = sql;
        params = values;
        return {
          rows: [{
            assignment_id: ASSIGNMENT_ID,
            employee_id: EMPLOYEE_ID,
            employee_name: "Alice Employee",
            individual_id: INDIVIDUAL_ID,
            individual_name: "Ari Individual",
            program_id: null,
            program_name: null,
            start_date: "2026-01-01",
            end_date: "2026-12-31",
            allowed_hours: "10",
            // A negative correction is intentionally not clamped or made absolute.
            actual_hours: "-2",
            scheduled_hours: "6",
          }],
        };
      }),
    } as unknown as PgLikePool;

    const result = await evaluateAssignmentAllowedHours(pool, {
      employeeId: EMPLOYEE_ID,
      individualIds: [INDIVIDUAL_ID],
      programId: PROGRAM_ID,
      onDate: "2026-01-01",
      excludeSessionId: SESSION_ID,
    });

    expect(params).toEqual([
      null,
      EMPLOYEE_ID,
      [INDIVIDUAL_ID],
      PROGRAM_ID,
      "2026-01-01",
      SESSION_ID,
      null,
      null,
    ]);
    expect(statement).toContain("sum(payroll_row.imported_hours)");
    expect(statement).toContain("canonical_service_date(");
    expect(statement).toContain(">= assignment.start_date");
    expect(statement).toContain("<= assignment.end_date");
    expect(statement).toContain("effective_payment_recipient(");
    expect(statement).toContain("= 'excellent_staffing'");
    expect(statement).toContain("assignment.program_id IS NULL OR payroll_row.program_id = assignment.program_id");
    expect(statement).toContain("assignment.program_id IS NULL OR session.program_id = assignment.program_id");
    expect(statement).toContain("session.status = 'pending'");
    expect(statement).toContain("session.matched_transaction_id IS NULL");
    expect(statement).toContain("session.archived_at IS NULL");
    expect(statement).toContain("session.id <> $6::uuid");
    expect(statement).toContain("session.series_id IS DISTINCT FROM $7::uuid");
    expect(statement).toContain("NULL::text, scheduled_program.payment_recipient");
    expect(statement).not.toContain("payroll_row.employee_id = session.employee_id");
    expect(statement).not.toContain("payroll_row.program_id = session.program_id");
    expect(statement).not.toContain("<= session.session_date");
    expect(statement).not.toContain("session.payment_recipient");
    expect(statement.toLowerCase()).not.toContain("abs(payroll_row.imported_hours");
    expect(statement.toLowerCase()).not.toContain("greatest(sum(payroll_row.imported_hours");
    expect(result).toEqual([expect.objectContaining({
      programId: null,
      allowedHours: "10.0000",
      actualHours: "-2.0000",
      scheduledHours: "6.0000",
      remainingHours: "6.0000",
      overLimit: false,
    })]);
  });

  it("selects both exact-program and null-program assignment scopes for a dated visit", async () => {
    let statement = "";
    const pool = {
      query: vi.fn(async (sql: string) => {
        statement = sql;
        return { rows: [] };
      }),
    } as unknown as PgLikePool;

    await evaluateAssignmentAllowedHours(pool, {
      employeeId: EMPLOYEE_ID,
      individualIds: [INDIVIDUAL_ID],
      programId: PROGRAM_ID,
      onDate: "2026-12-31",
    });

    expect(statement).toContain("$4::uuid IS NULL OR assignment.program_id IS NULL OR assignment.program_id = $4::uuid");
    expect(statement).toContain("assignment.start_date <= $5::date");
    expect(statement).toContain("assignment.end_date >= $5::date");
  });

  it("projects the exact boundary as within limit and the next fraction as over", () => {
    const atBoundary = projectAssignmentAllowedHours(evaluation(), "2");
    expect(atBoundary).toEqual(expect.objectContaining({
      scheduledHours: "6.0000",
      remainingHours: "0.0000",
      overLimit: false,
    }));

    const over = projectAssignmentAllowedHours(evaluation(), "2.0001");
    expect(over).toEqual(expect.objectContaining({
      scheduledHours: "6.0001",
      remainingHours: "-0.0001",
      overLimit: true,
    }));
  });

  it("finds the exact cumulative crossing occurrence inside the assignment window", async () => {
    let params: unknown[] | undefined;
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("WITH requested_dates AS")) {
          return {
            rows: [
              { on_date: "2026-01-01", payment_recipient: "excellent_staffing" },
              { on_date: "2026-01-08", payment_recipient: "excellent_staffing" },
              { on_date: "2026-01-15", payment_recipient: "excellent_staffing" },
            ],
          };
        }
        params = values;
        return {
          rows: [{
            assignment_id: ASSIGNMENT_ID,
            employee_id: EMPLOYEE_ID,
            employee_name: "Alice Employee",
            individual_id: INDIVIDUAL_ID,
            individual_name: "Ari Individual",
            program_id: PROGRAM_ID,
            program_name: "Com Hab",
            start_date: "2026-01-08",
            end_date: "2026-12-31",
            allowed_hours: "5",
            actual_hours: "1",
            scheduled_hours: "1",
          }],
        };
      }),
    } as unknown as PgLikePool;

    const result = await projectSeriesAssignmentAllowedHours(pool, {
      employeeId: EMPLOYEE_ID,
      programId: PROGRAM_ID,
      individualIds: [INDIVIDUAL_ID],
      occurrenceDates: ["2026-01-15", "2026-01-01", "2026-01-08", "2026-01-08"],
      durationHours: "2",
      excludeSeriesId: SESSION_ID,
      excludeSeriesFromDate: "2026-01-08",
    });

    expect(params).toEqual([
      null,
      EMPLOYEE_ID,
      [INDIVIDUAL_ID],
      PROGRAM_ID,
      null,
      null,
      SESSION_ID,
      "2026-01-08",
    ]);
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      occurrenceCount: 3,
      durationHours: "2.0000",
      assignments: [{
        assignment: expect.objectContaining({
          assignmentId: ASSIGNMENT_ID,
          allowedHours: "5.0000",
          actualHours: "1.0000",
          scheduledHours: "1.0000",
        }),
        seriesOccurrenceCount: 2,
        seriesHours: "4.0000",
        remainingAfterHours: "-1.0000",
        overLimit: true,
        crossingOccurrence: {
          occurrenceDate: "2026-01-15",
          occurrenceNumber: 3,
          assignmentOccurrenceNumber: 2,
          scheduledBeforeHours: "3.0000",
          projectedScheduledHours: "5.0000",
          projectedTotalHours: "6.0000",
          remainingHours: "-1.0000",
          overByHours: "1.0000",
        },
      }],
    });
  });

  it("does not issue an unscoped or malformed data query", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as PgLikePool;

    expect(await evaluateAssignmentAllowedHours(pool, {})).toEqual([]);
    expect(await evaluateAssignmentAllowedHours(pool, { assignmentIds: [] })).toEqual([]);
    expect(await evaluateAssignmentAllowedHours(pool, { employeeId: "not-a-uuid" })).toEqual([]);
    expect(await evaluateAssignmentAllowedHours(pool, {
      employeeId: EMPLOYEE_ID,
      onDate: "2026-02-30",
    })).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
