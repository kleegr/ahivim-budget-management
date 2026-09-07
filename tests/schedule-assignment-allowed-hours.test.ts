import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import type { AccessScope } from "@/lib/auth/access";

const mocks = vi.hoisted(() => ({
  evaluateAssignmentAllowedHours: vi.fn(),
  resolveSchedulePaymentRecipient: vi.fn(),
}));

vi.mock("@/lib/data/assignment-allowed-hours", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/data/assignment-allowed-hours")>(),
  evaluateAssignmentAllowedHours: mocks.evaluateAssignmentAllowedHours,
}));

vi.mock("@/lib/data/schedule-payment-routing", () => ({
  resolveSchedulePaymentRecipient: mocks.resolveSchedulePaymentRecipient,
}));

vi.mock("@/lib/data/schedule-queries", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/data/schedule-queries")>(),
  individualProgramForecast: vi.fn(async () => ({
    actualHours: "0.0000",
    scheduledHours: "0.0000",
    remainingAfterScheduleHours: "100.0000",
    authorizedHours: "100.0000",
    authorizationCount: 1,
    authorizationAmbiguous: false,
    sourceCandidateCount: 1,
    sourceAmbiguous: false,
  })),
}));

vi.mock("@/lib/data/employee-availability", () => ({
  listEmployeeAvailability: vi.fn(async () => ({
    timeRangeKnown: true,
    occurrenceCount: 1,
    employees: [{
      employeeId: EMPLOYEE_ID,
      employeeName: "Alice Employee",
      assignedOccurrenceCount: 1,
      assignedToAll: true,
      conflictingOccurrenceCount: 0,
      unavailableOccurrenceCount: 0,
      outsideDeclaredAvailabilityOccurrenceCount: 0,
    }],
  })),
}));

import {
  assignmentAllowedHoursWarning,
  createSession,
  detectConflicts,
  SCHEDULE_OVERRIDE_REQUIRED_MESSAGE,
  warningsRequiringScheduleOverride,
} from "@/lib/manage/schedule";
import { listSessionWarningFlags } from "@/lib/data/schedule-queries";

const ASSIGNMENT_ID = "10000000-0000-4000-8000-000000000001";
const EMPLOYEE_ID = "20000000-0000-4000-8000-000000000001";
const INDIVIDUAL_ID = "30000000-0000-4000-8000-000000000001";
const PROGRAM_ID = "40000000-0000-4000-8000-000000000001";
const SESSION_ID = "50000000-0000-4000-8000-000000000001";
const ACTOR_ID = "60000000-0000-4000-8000-000000000001";

const draft = {
  employeeId: EMPLOYEE_ID,
  programId: PROGRAM_ID,
  individualIds: [INDIVIDUAL_ID],
  sessionDate: "2026-09-07",
  startTime: "09:00",
  endTime: "11:00",
  durationHours: "2",
};

function assignmentEvaluation() {
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
    allowedHours: "9.0000",
    actualHours: "0.0000",
    scheduledHours: "8.0000",
    remainingHours: "1.0000",
    overLimit: false,
  };
}

function queryHarness() {
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params });
    if (sql.includes("FROM programs WHERE id")) {
      return { rows: [{
        is_active: true,
        name: "Com Hab",
        groups_allowed: true,
        one_to_one_required: false,
        max_group_size: null,
        allow_multiple_employees: true,
      }] };
    }
    if (sql.includes("FROM program_rate_schedules")) {
      return { rows: [{
        agency_rate: "25.0000",
        internal_rate: "20.0000",
        effective_from: "2026-01-01",
        effective_to: null,
      }] };
    }
    if (sql.includes("FROM employees e") && sql.includes("LEFT JOIN scheduled_sessions s")) {
      return { rows: [{
        status: "active",
        display_name: "Alice Employee",
        session_id: null,
        start_time: null,
        end_time: null,
      }] };
    }
    if (sql.includes("WITH requested_individuals AS")) {
      return { rows: [{
        individual_id: INDIVIDUAL_ID,
        status: "active",
        display_name: "Ari Individual",
        assigned: true,
        session_id: null,
        employee_id: null,
        start_time: null,
        end_time: null,
      }] };
    }
    if (sql.includes("INSERT INTO scheduled_sessions")) return { rows: [{ id: SESSION_ID }] };
    return { rows: [] };
  });
  const client = { query, release: vi.fn() } as unknown as PgLikeClient;
  const pool = {
    query,
    connect: vi.fn(async () => client),
  } as unknown as PgLikePool;
  return { pool, statements };
}

describe("schedule assignment allowed-hours parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.evaluateAssignmentAllowedHours.mockResolvedValue([assignmentEvaluation()]);
    mocks.resolveSchedulePaymentRecipient.mockResolvedValue("excellent_staffing");
  });

  it("adds one precise record/action warning using existing scheduled hours plus the draft once", async () => {
    const { pool } = queryHarness();
    const warnings = await detectConflicts(pool, draft);
    const limitWarning = warnings.find((warning) => warning.code === "over_assignment_allowed_hours");

    expect(mocks.evaluateAssignmentAllowedHours).toHaveBeenCalledWith(pool, {
      employeeId: EMPLOYEE_ID,
      individualIds: [INDIVIDUAL_ID],
      programId: PROGRAM_ID,
      onDate: "2026-09-07",
      excludeSessionId: null,
    });
    expect(mocks.resolveSchedulePaymentRecipient).toHaveBeenCalledWith(pool, {
      employeeId: EMPLOYEE_ID,
      programId: PROGRAM_ID,
      onDate: "2026-09-07",
    });
    expect(limitWarning).toEqual(expect.objectContaining({
      severity: "warning",
      record: {
        type: "assignment",
        id: ASSIGNMENT_ID,
        label: "Alice Employee / Ari Individual",
      },
      action: expect.objectContaining({
        label: "Review assignment",
        href: expect.stringContaining("view=future"),
      }),
    }));
    expect(limitWarning?.message).toContain("pending unmatched scheduled is 8.0000 h");
    expect(limitWarning?.message).toContain("this visit adds 2.0000 h");
    expect(limitWarning?.message).toContain("bringing the assignment to 10.0000 h (1.0000 h over)");
  });

  it("identifies the exact first crossing occurrence in a recurring preview warning", () => {
    const warning = assignmentAllowedHoursWarning({
      ...assignmentEvaluation(),
      scheduledHours: "9.0000",
    }, "2", {
      date: "2026-09-21",
      number: 3,
    });

    expect(warning).toEqual(expect.objectContaining({
      code: "over_assignment_allowed_hours",
      message: expect.stringContaining(
        "Occurrence 3 on 2026-09-21 is the first visit in this preview that exceeds the limit.",
      ),
      record: expect.objectContaining({ id: ASSIGNMENT_ID }),
      action: expect.objectContaining({ label: "Review assignment" }),
    }));
  });

  it("does not evaluate assignment hours for a direct-pay program", async () => {
    mocks.resolveSchedulePaymentRecipient.mockResolvedValue("employee");
    const { pool } = queryHarness();
    const warnings = await detectConflicts(pool, draft);

    expect(mocks.evaluateAssignmentAllowedHours).not.toHaveBeenCalled();
    expect(warnings.map((warning) => warning.code)).not.toContain("over_assignment_allowed_hours");
  });

  it("does not evaluate, require, or store assignment-hour evidence without the policy grant", async () => {
    const { pool, statements } = queryHarness();
    const saved = await createSession(pool, draft, ACTOR_ID, null, {
      enforceAssignmentAllowedHoursWarnings: false,
    });

    expect(saved.ok).toBe(true);
    expect(mocks.evaluateAssignmentAllowedHours).not.toHaveBeenCalled();
    const insert = statements.find((entry) => entry.sql.includes("INSERT INTO scheduled_sessions"));
    expect(insert?.params?.[15]).toBeNull();

    const warning = assignmentAllowedHoursWarning(assignmentEvaluation(), "2")!;
    expect(warningsRequiringScheduleOverride([warning], {
      enforceAssignmentAllowedHoursWarnings: false,
    })).toEqual([]);
  });

  it("uses the existing policy-aware override path and records an accepted reason", async () => {
    const withoutReasonHarness = queryHarness();
    const rejected = await createSession(withoutReasonHarness.pool, draft, ACTOR_ID);
    expect(rejected).toEqual({
      ok: false,
      code: "validation",
      message: SCHEDULE_OVERRIDE_REQUIRED_MESSAGE,
    });
    expect(withoutReasonHarness.statements.map((entry) => entry.sql)).toContain("ROLLBACK");
    expect(withoutReasonHarness.statements.map((entry) => entry.sql)).not.toContain("COMMIT");

    const acceptedHarness = queryHarness();
    const accepted = await createSession(
      acceptedHarness.pool,
      draft,
      ACTOR_ID,
      "Supervisor approved one additional visit",
    );
    expect(accepted.ok).toBe(true);
    expect(acceptedHarness.statements.map((entry) => entry.sql)).toContain("COMMIT");
    const audit = acceptedHarness.statements.find((entry) => entry.sql.includes("INSERT INTO audit_logs"));
    expect(audit?.params).toEqual(expect.arrayContaining([
      "session_scheduled",
      SESSION_ID,
      "Supervisor approved one additional visit",
    ]));

    const warning = {
      code: "over_assignment_allowed_hours",
      severity: "warning" as const,
      message: "Assignment limit exceeded",
    };
    expect(warningsRequiringScheduleOverride([warning], { enforceBudgetWarnings: true })).toEqual([warning]);
    expect(warningsRequiringScheduleOverride([warning], { enforceBudgetWarnings: false })).toEqual([warning]);
  });

  it("exposes a stored operational assignment-limit conflict without budget access", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [{
          id: SESSION_ID,
          warnings: [{
            code: "over_assignment_allowed_hours",
            message: "Assignment limit exceeded",
          }],
          has_conflict: false,
          has_availability_conflict: false,
          has_budget_risk: false,
          has_assignment_gap: false,
        }],
      })),
    } as unknown as PgLikePool;
    const restricted = { full: true, canSeeBudgets: false } as AccessScope;
    const visible = { full: true, canSeeBudgets: true } as AccessScope;

    const restrictedFlags = await listSessionWarningFlags(pool, {
      from: "2026-09-07",
      to: "2026-09-07",
    }, restricted);
    const visibleFlags = await listSessionWarningFlags(pool, {
      from: "2026-09-07",
      to: "2026-09-07",
    }, visible);

    expect(restrictedFlags[0]).toEqual(expect.objectContaining({
      hasConflict: true,
      hasScheduleConflict: true,
      hasBudgetRisk: false,
      hasOtherWarning: false,
      warningCount: 1,
    }));
    expect(visibleFlags[0]).toEqual(expect.objectContaining({
      hasConflict: true,
      hasScheduleConflict: true,
      hasBudgetRisk: false,
      hasOtherWarning: false,
      warningCount: 1,
    }));
  });
});
