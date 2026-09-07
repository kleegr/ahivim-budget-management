import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import type { AccessScope } from "@/lib/auth/access";

const mocks = vi.hoisted(() => ({
  projectDirectPayScheduleLimits: vi.fn(),
  resolveSchedulePaymentRecipient: vi.fn(),
  evaluateAssignmentAllowedHours: vi.fn(),
}));

vi.mock("@/lib/data/direct-pay-schedule-limit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/data/direct-pay-schedule-limit")>(),
  projectDirectPayScheduleLimits: mocks.projectDirectPayScheduleLimits,
}));

vi.mock("@/lib/data/schedule-payment-routing", () => ({
  resolveSchedulePaymentRecipient: mocks.resolveSchedulePaymentRecipient,
}));

vi.mock("@/lib/data/assignment-allowed-hours", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/data/assignment-allowed-hours")>(),
  evaluateAssignmentAllowedHours: mocks.evaluateAssignmentAllowedHours,
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
  createSeries,
  createSession,
  detectConflicts,
  directPayScheduleLimitWarning,
  duplicateSession,
  reassignSession,
  rescheduleSession,
  SCHEDULE_OVERRIDE_REQUIRED_MESSAGE,
  setSessionStatus,
  updateSeries,
  warningsRequiringScheduleOverride,
  type CreateSeriesInput,
  type UpdateSeriesInput,
} from "@/lib/manage/schedule";
import { listSessionWarningFlags } from "@/lib/data/schedule-queries";
import { getPlanningWorkspace } from "@/lib/data/planning-queries";

const TARGET_ID = "10000000-0000-4000-8000-000000000001";
const EMPLOYEE_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_EMPLOYEE_ID = "20000000-0000-4000-8000-000000000002";
const INDIVIDUAL_ID = "30000000-0000-4000-8000-000000000001";
const PROGRAM_ID = "40000000-0000-4000-8000-000000000001";
const SESSION_ID = "50000000-0000-4000-8000-000000000001";
const SERIES_ID = "60000000-0000-4000-8000-000000000001";
const ACTOR_ID = "70000000-0000-4000-8000-000000000001";

const draft = {
  employeeId: EMPLOYEE_ID,
  programId: PROGRAM_ID,
  individualIds: [INDIVIDUAL_ID],
  sessionDate: "2026-09-07",
  startTime: "09:00",
  endTime: "11:00",
  durationHours: "2",
};

function projection(employeeId = EMPLOYEE_ID, occurrenceDate = "2026-09-07") {
  return {
    targetId: TARGET_ID,
    employeeId,
    employeeName: "Alice Employee",
    windowStart: "2026-09-01",
    windowEnd: "2026-09-07",
    targetHours: "10.0000",
    recordedHours: "4.0000",
    scheduledHours: "5.0000",
    candidateHours: "2.0000",
    candidateOccurrenceCount: 1,
    projectedHours: "11.0000",
    overageHours: "1.0000",
    overLimit: true,
    crossingOccurrence: { occurrenceDate, occurrenceNumber: 1 },
  };
}

function queryHarness() {
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params });
    if (sql.includes("CURRENT_DATE::text AS today") && sql.includes("FROM schedule_series")) {
      return { rows: [{
        employee_id: EMPLOYEE_ID,
        program_id: PROGRAM_ID,
        service_type: null,
        frequency: "daily",
        interval: 1,
        weekdays: [],
        recurrence_anchor_date: "2026-09-07",
        start_date: "2026-09-07",
        end_date: "2026-09-07",
        start_time: "09:00",
        end_time: "11:00",
        duration_hours: "2.0000",
        status: "active",
        notes: null,
        today: "2026-09-07",
      }] };
    }
    if (sql.includes("SELECT count(*)::text AS count") && sql.includes("FROM scheduled_sessions")) {
      return { rows: [{ count: "0" }] };
    }
    if (sql.includes("SELECT DISTINCT session_date::text") && sql.includes("FROM scheduled_sessions")) {
      return { rows: [] };
    }
    if (sql.includes("FROM schedule_series_individuals") && sql.includes("individual_id::text")) {
      return { rows: [{ individual_id: INDIVIDUAL_ID }] };
    }
    if (sql.includes("FROM scheduled_sessions WHERE id = $1 FOR UPDATE")) {
      return { rows: [{
        employee_id: EMPLOYEE_ID,
        program_id: PROGRAM_ID,
        session_date: "2026-09-07",
        start_time: "09:00",
        end_time: "11:00",
        duration_hours: "2.0000",
        matched_transaction_id: null,
      }] };
    }
    if (sql.includes("FROM scheduled_sessions WHERE id = $1")) {
      return { rows: [{
        employee_id: EMPLOYEE_ID,
        program_id: PROGRAM_ID,
        service_type: null,
        start_time: "09:00",
        end_time: "11:00",
        duration_hours: "2.0000",
        notes: null,
      }] };
    }
    if (sql.includes("SELECT individual_id FROM scheduled_allocations")) {
      return { rows: [{ individual_id: INDIVIDUAL_ID }] };
    }
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
    if (sql.includes("INSERT INTO schedule_series") && sql.includes("RETURNING id")) {
      return { rows: [{ id: SERIES_ID }] };
    }
    if (sql.includes("INSERT INTO scheduled_sessions")) return { rows: [{ id: SESSION_ID }] };
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() } as unknown as PgLikeClient;
  const pool = {
    query,
    connect: vi.fn(async () => client),
  } as unknown as PgLikePool;
  return { pool, statements };
}

function seriesInput(employeeId = EMPLOYEE_ID): CreateSeriesInput {
  return {
    ...draft,
    employeeId,
    frequency: "daily",
    interval: 1,
    weekdays: [],
    startDate: "2026-09-07",
    endDate: "2026-09-07",
  };
}

describe("Direct-Pay schedule enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSchedulePaymentRecipient.mockResolvedValue("employee");
    mocks.evaluateAssignmentAllowedHours.mockResolvedValue([]);
    mocks.projectDirectPayScheduleLimits.mockImplementation(async (_pool, input) => [
      projection(input.employeeId, input.occurrenceDates[0]),
    ]);
  });

  it("emits one employee-scoped, hours-only warning with exact record and action evidence", async () => {
    const { pool } = queryHarness();
    const warnings = await detectConflicts(pool, draft);
    const warning = warnings.find((entry) => entry.code === "over_direct_pay_target_hours");

    expect(mocks.evaluateAssignmentAllowedHours).not.toHaveBeenCalled();
    expect(mocks.projectDirectPayScheduleLimits).toHaveBeenCalledWith(pool, expect.objectContaining({
      employeeId: EMPLOYEE_ID,
      occurrenceDates: ["2026-09-07"],
      durationHours: "2",
      excludeSessionId: null,
    }));
    expect(warning).toEqual(expect.objectContaining({
      record: {
        type: "employee_direct_pay_target",
        id: TARGET_ID,
        label: "Alice Employee / 2026-09-01 to 2026-09-07",
      },
      action: {
        label: "Review Direct-Pay target",
        href: `/schedule?view=targets&employeeId=${EMPLOYEE_ID}`,
      },
    }));
    expect(warning?.message).toContain("Actual is 4.0000 h");
    expect(warning?.message).toContain("pending unmatched scheduled is 5.0000 h");
    expect(warning?.message).toContain("projected coverage to 11.0000 h (1.0000 h over)");
    expect(warning?.message).not.toMatch(/gross|rate|\$/i);
  });

  it("keeps Direct-Pay and agency assignment limits mutually exclusive", async () => {
    const { pool } = queryHarness();
    mocks.resolveSchedulePaymentRecipient.mockResolvedValue("excellent_staffing");

    await detectConflicts(pool, draft);

    expect(mocks.projectDirectPayScheduleLimits).not.toHaveBeenCalled();
    expect(mocks.evaluateAssignmentAllowedHours).toHaveBeenCalledOnce();
  });

  it("serializes the final create check, requires a reason, and audits an accepted override", async () => {
    const rejectedHarness = queryHarness();
    const rejected = await createSession(rejectedHarness.pool, draft, ACTOR_ID);
    expect(rejected).toEqual({
      ok: false,
      code: "validation",
      message: SCHEDULE_OVERRIDE_REQUIRED_MESSAGE,
    });
    const rejectedStatements = rejectedHarness.statements.map((entry) => entry.sql);
    const targetLockIndex = rejectedStatements.findIndex((sql) => sql.includes("direct-pay-target:"));
    const targetCheckIndex = rejectedStatements.findIndex((sql) => sql.includes("FROM programs WHERE id"));
    expect(targetLockIndex).toBeGreaterThanOrEqual(0);
    expect(targetCheckIndex).toBeGreaterThan(targetLockIndex);
    expect(rejectedStatements).toContain("ROLLBACK");
    expect(rejectedStatements).not.toContain("COMMIT");

    const acceptedHarness = queryHarness();
    const reason = "Supervisor approved one additional Direct-Pay visit";
    const accepted = await createSession(acceptedHarness.pool, draft, ACTOR_ID, reason);
    expect(accepted.ok).toBe(true);
    expect(acceptedHarness.statements.map((entry) => entry.sql)).toContain("COMMIT");
    const audit = acceptedHarness.statements.find((entry) => entry.sql.includes("INSERT INTO audit_logs"));
    expect(audit?.params).toEqual(expect.arrayContaining([
      "session_scheduled",
      SESSION_ID,
      reason,
    ]));
  });

  it("applies the same final guard to recurring create and recurring replacement", async () => {
    const createHarness = queryHarness();
    const created = await createSeries(createHarness.pool, seriesInput(), ACTOR_ID);
    expect(created).toEqual(expect.objectContaining({
      ok: false,
      code: "validation",
      message: SCHEDULE_OVERRIDE_REQUIRED_MESSAGE,
    }));
    expect(createHarness.statements.some((entry) => entry.sql.includes("direct-pay-target:"))).toBe(true);

    const updateHarness = queryHarness();
    const updated = await updateSeries(
      updateHarness.pool,
      SERIES_ID,
      { ...seriesInput(), status: "active" } as UpdateSeriesInput,
      ACTOR_ID,
    );
    expect(updated).toEqual(expect.objectContaining({
      ok: false,
      code: "validation",
      message: SCHEDULE_OVERRIDE_REQUIRED_MESSAGE,
    }));
    expect(updateHarness.statements.some((entry) => entry.sql.includes("direct-pay-target:"))).toBe(true);
  });

  it("rolls a recurring save back when a later occurrence crosses after earlier inserts accumulate", async () => {
    const { pool, statements } = queryHarness();
    mocks.projectDirectPayScheduleLimits
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([projection(EMPLOYEE_ID, "2026-09-08")]);

    const result = await createSeries(
      pool,
      { ...seriesInput(), endDate: "2026-09-08" },
      ACTOR_ID,
    );

    expect(result).toEqual({
      ok: false,
      code: "validation",
      message: SCHEDULE_OVERRIDE_REQUIRED_MESSAGE,
    });
    expect(mocks.projectDirectPayScheduleLimits).toHaveBeenCalledTimes(2);
    expect(statements.filter((entry) => entry.sql.includes("INSERT INTO scheduled_sessions"))).toHaveLength(2);
    expect(statements).toContainEqual(expect.objectContaining({ sql: "ROLLBACK" }));
    expect(statements).not.toContainEqual(expect.objectContaining({ sql: "COMMIT" }));
  });

  it("prohibits reactivating a non-pending visit so limits cannot be bypassed", async () => {
    const statements: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params });
      if (sql.includes("SELECT status, matched_transaction_id")) {
        return { rows: [{ status: "cancelled", matched_transaction_id: null }] };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release: vi.fn() } as unknown as PgLikeClient;
    const pool = {
      query,
      connect: vi.fn(async () => client),
    } as unknown as PgLikePool;

    await expect(setSessionStatus(pool, SESSION_ID, "pending", ACTOR_ID, "Reopen")).resolves.toEqual({
      ok: false,
      code: "immutable",
      message: "A completed, cancelled, or no-show session cannot be reactivated. Duplicate the visit to create a new pending session with current scheduling checks.",
    });
    expect(statements.map((entry) => entry.sql)).toContain("ROLLBACK");
    expect(statements.some((entry) => entry.sql.includes("UPDATE scheduled_sessions"))).toBe(false);
    expect(statements.some((entry) => entry.sql.includes("INSERT INTO audit_logs"))).toBe(false);
  });

  it("rechecks move, employee change, and duplicate operations with exact exclusions", async () => {
    const rescheduleHarness = queryHarness();
    const rescheduled = await rescheduleSession(
      rescheduleHarness.pool,
      SESSION_ID,
      { sessionDate: "2026-09-08" },
      ACTOR_ID,
    );
    expect(rescheduled).toEqual(expect.objectContaining({
      ok: false,
      message: SCHEDULE_OVERRIDE_REQUIRED_MESSAGE,
    }));
    expect(mocks.projectDirectPayScheduleLimits).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        occurrenceDates: ["2026-09-08"],
        excludeSessionId: SESSION_ID,
      }),
    );

    const reassignHarness = queryHarness();
    const reassigned = await reassignSession(
      reassignHarness.pool,
      SESSION_ID,
      OTHER_EMPLOYEE_ID,
      ACTOR_ID,
    );
    expect(reassigned).toEqual(expect.objectContaining({
      ok: false,
      message: SCHEDULE_OVERRIDE_REQUIRED_MESSAGE,
    }));
    expect(mocks.projectDirectPayScheduleLimits).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ employeeId: OTHER_EMPLOYEE_ID, excludeSessionId: SESSION_ID }),
    );
    const reassignTargetLocks = reassignHarness.statements
      .filter((entry) => entry.sql.includes("direct-pay-target:"))
      .map((entry) => entry.params?.[0]);
    expect(reassignTargetLocks).toEqual([EMPLOYEE_ID, OTHER_EMPLOYEE_ID]);

    const duplicateHarness = queryHarness();
    const duplicated = await duplicateSession(
      duplicateHarness.pool,
      SESSION_ID,
      "2026-09-09",
      ACTOR_ID,
    );
    expect(duplicated).toEqual(expect.objectContaining({
      ok: false,
      message: SCHEDULE_OVERRIDE_REQUIRED_MESSAGE,
    }));
    expect(mocks.projectDirectPayScheduleLimits).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ occurrenceDates: ["2026-09-09"], excludeSessionId: null }),
    );
  });

  it("does not evaluate, require, or disclose a Direct-Pay target without the policy grant", async () => {
    const { pool, statements } = queryHarness();
    const saved = await createSession(pool, draft, ACTOR_ID, null, {
      enforceBudgetWarnings: true,
      enforceDirectPayTargetWarnings: false,
    });
    expect(saved.ok).toBe(true);
    expect(mocks.projectDirectPayScheduleLimits).not.toHaveBeenCalled();
    expect(statements.some((entry) => entry.sql.includes("direct-pay-target:"))).toBe(false);

    const warning = directPayScheduleLimitWarning(projection())!;
    expect(warningsRequiringScheduleOverride([warning], {
      enforceDirectPayTargetWarnings: false,
    })).toEqual([]);

    const warningPool = {
      query: vi.fn(async () => ({
        rows: [{
          id: SESSION_ID,
          warnings: [warning],
          has_conflict: false,
          has_availability_conflict: false,
          has_budget_risk: false,
          has_assignment_gap: false,
        }],
      })),
    } as unknown as PgLikePool;
    const agencyScope = {
      full: false,
      allIndividuals: false,
      allEmployees: false,
      canSeeBudgets: true,
    } as AccessScope;
    const internalScope = {
      full: true,
      allIndividuals: true,
      allEmployees: true,
      canSeeBudgets: true,
    } as AccessScope;

    const hidden = await listSessionWarningFlags(warningPool, {
      from: "2026-09-07",
      to: "2026-09-07",
    }, agencyScope);
    const visible = await listSessionWarningFlags(warningPool, {
      from: "2026-09-07",
      to: "2026-09-07",
    }, internalScope);
    expect(hidden[0]).toEqual(expect.objectContaining({ hasOtherWarning: false, warningCount: 0 }));
    expect(visible[0]).toEqual(expect.objectContaining({ hasOtherWarning: true, warningCount: 1 }));

    const planningQuery = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    await getPlanningWorkspace(
      { query: planningQuery } as unknown as PgLikePool,
      "2026-09-07",
      agencyScope,
      ["80000000-0000-4000-8000-000000000001"],
    );
    const planningSql = planningQuery.mock.calls.map(([sql]) => sql).join("\n");
    expect(planningSql.match(/over_direct_pay_target_hours/g)).toHaveLength(2);
    expect(planningSql).toContain("$4::boolean IS NOT TRUE");
  });
});
