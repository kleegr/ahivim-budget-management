import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { hasTestDatabase, testPool, resetSchema, truncateBusinessTables, closeTestPool } from "../support/database";
import type { PgLikePool } from "@/lib/import/commit";
import { createIndividual } from "@/lib/manage/individuals";
import { createEmployee } from "@/lib/manage/employees";
import { createAssignment } from "@/lib/manage/assignments";
import { createBudgetPeriod, createAuthorization } from "@/lib/manage/authorizations";
import { addProgramRate } from "@/lib/manage/programs";
import {
  createSession, createSeries, updateSeries, setSessionStatus, rescheduleSession, duplicateSession, cancelSeries, detectConflicts,
} from "@/lib/manage/schedule";
import {
  individualProgramForecast, listSessions, scheduledByProgramForIndividual, scheduledTotals,
} from "@/lib/data/schedule-queries";
import { dec } from "@/lib/money";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000000001";
let pool: PgLikePool;

async function scalar<T>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await testPool().query<Record<string, T>>(sql, params);
  return Object.values(rows[0])[0];
}
async function programId(code: string): Promise<string> {
  return scalar<string>(`SELECT id FROM programs WHERE code = $1`, [code]);
}
function unwrap<T>(r: { ok: true; data: T } | { ok: false; code: string; message: string }): T {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.data;
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

suite("scheduling (real PostgreSQL)", () => {
  beforeAll(async () => { await resetSchema(); pool = testPool(); }, 60_000);
  beforeEach(async () => {
    await truncateBusinessTables();
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role) VALUES ($1,$2,$3,'x','admin')`,
      [ACTOR, "a@a.test", "Admin"],
    );
  });
  afterAll(closeTestPool);

  async function fixture() {
    // Day Hab is group-capable and seeded with agency 19 / internal 17.
    const dayHab = await programId("DAY_HAB");
    const ind = unwrap(await createIndividual(pool, { displayName: "Aaron Levy" }, ACTOR));
    const emp = unwrap(await createEmployee(pool, { displayName: "Miriam Klein" }, ACTOR));
    unwrap(await createAssignment(pool, { employeeId: emp.id, individualId: ind.id, programId: dayHab }, ACTOR));
    const period = unwrap(await createBudgetPeriod(pool, { individualId: ind.id, label: "FY25", startDate: "2025-01-01", endDate: "2025-12-31" }, ACTOR));
    unwrap(await createAuthorization(pool, { budgetPeriodId: period.id, programId: dayHab, authorizedHours: "100", internalRate: "17" }, ACTOR));
    return { dayHab, ind, emp };
  }

  it("schedules a single session with expected billing and one full-hours allocation", async () => {
    const { dayHab, ind, emp } = await fixture();
    const res = unwrap(await createSession(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      sessionDate: "2025-03-10", startTime: "09:00", endTime: "12:00", durationHours: "3",
    }, ACTOR));
    // Day Hab: agency 19, internal 17. 3h -> agency 57, internal 51.
    const s = await scalar<string>(`SELECT expected_internal_amount::text FROM scheduled_sessions WHERE id=$1`, [res.id]);
    expect(dec(s).toNumber()).toBe(51);
    const alloc = await testPool().query<{ allocation_hours: string; allocated_amount: string }>(
      `SELECT allocation_hours::text, allocated_amount::text FROM scheduled_allocations WHERE scheduled_session_id=$1`, [res.id]);
    expect(alloc.rows).toHaveLength(1);
    expect(dec(alloc.rows[0].allocation_hours).toNumber()).toBe(3);
    expect(res.warnings.map((w) => w.code)).not.toContain("over_authorized_hours");
  });

  it("a group session gives every individual the full hours; money is the combined total", async () => {
    const { dayHab, emp } = await fixture();
    const a = unwrap(await createIndividual(pool, { displayName: "Bella Stern" }, ACTOR));
    const b = unwrap(await createIndividual(pool, { displayName: "Chaya Roth" }, ACTOR));
    const c = unwrap(await createIndividual(pool, { displayName: "Dov Weiss" }, ACTOR));
    const res = unwrap(await createSession(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [a.id, b.id, c.id],
      sessionDate: "2025-03-11", startTime: "09:00", endTime: "22:00", durationHours: "13",
    }, ACTOR, "group setup intentionally incomplete"));
    const allocs = await testPool().query<{ allocation_hours: string; allocated_amount: string }>(
      `SELECT allocation_hours::text, allocated_amount::text FROM scheduled_allocations WHERE scheduled_session_id=$1`, [res.id]);
    expect(allocs.rows).toHaveLength(3);
    for (const r of allocs.rows) {
      expect(dec(r.allocation_hours).toNumber()).toBe(13);   // full hours, not 13/3
      expect(dec(r.allocated_amount).toNumber()).toBe(221);  // 13 x 17
    }
    const combined = await scalar<string>(`SELECT expected_internal_amount::text FROM scheduled_sessions WHERE id=$1`, [res.id]);
    expect(dec(combined).toNumber()).toBe(663); // 3 x 221
  });

  it("treats repeated participant IDs as one individual", async () => {
    const { dayHab, ind, emp } = await fixture();
    const res = unwrap(await createSession(pool, {
      employeeId: emp.id,
      programId: dayHab,
      individualIds: [ind.id, ind.id, ind.id],
      sessionDate: "2025-03-11",
      startTime: "09:00",
      endTime: "12:00",
      durationHours: "3",
    }, ACTOR));

    const saved = await pool.query<{ group_size: number; expected_internal_amount: string }>(
      `SELECT group_size, expected_internal_amount::text
         FROM scheduled_sessions WHERE id = $1`,
      [res.id],
    );
    const allocations = await scalar<string>(
      `SELECT count(*)::text FROM scheduled_allocations WHERE scheduled_session_id = $1`,
      [res.id],
    );
    expect(saved.rows[0]?.group_size).toBe(1);
    expect(dec(saved.rows[0]!.expected_internal_amount).toNumber()).toBe(51);
    expect(allocations).toBe("1");
  });

  it("warns when scheduling exceeds the remaining authorization", async () => {
    const { dayHab, ind, emp } = await fixture(); // 100 authorized
    const rejected = await createSession(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      sessionDate: "2025-03-10", durationHours: "120", startTime: null, endTime: null,
    }, ACTOR);
    expect(rejected).toMatchObject({
      ok: false,
      code: "validation",
      message: expect.stringMatching(/written override reason/i),
    });
    expect(Number(await scalar<string>(`SELECT count(*)::text FROM scheduled_sessions`, []))).toBe(0);

    const res = unwrap(await createSession(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      sessionDate: "2025-03-10", durationHours: "120", startTime: null, endTime: null,
    }, ACTOR, "approved authorization overage"));
    expect(res.warnings.map((w) => w.code)).toContain("over_authorized_hours");
  });

  it("warns on employee double-booking and outside-authorization dates", async () => {
    const { dayHab, ind, emp } = await fixture();
    await createSession(pool, { employeeId: emp.id, programId: dayHab, individualIds: [ind.id], sessionDate: "2025-03-10", startTime: "09:00", endTime: "12:00", durationHours: "3" }, ACTOR);
    const second = unwrap(await createSession(pool, { employeeId: emp.id, programId: dayHab, individualIds: [ind.id], sessionDate: "2025-03-10", startTime: "10:00", endTime: "13:00", durationHours: "3" }, ACTOR, "approved overlap"));
    expect(second.warnings.map((w) => w.code)).toContain("employee_double_booked");

    const outside = await detectConflicts(pool, { employeeId: emp.id, programId: dayHab, individualIds: [ind.id], sessionDate: "2027-01-01", startTime: null, endTime: null, durationHours: "1" });
    expect(outside.map((w) => w.code)).toContain("outside_authorization_dates");
  });

  it("requires an override when only a later recurring occurrence conflicts", async () => {
    const { dayHab, ind, emp } = await fixture();
    unwrap(await createSession(pool, {
      employeeId: emp.id,
      programId: dayHab,
      individualIds: [ind.id],
      sessionDate: "2025-03-17",
      startTime: "10:00",
      endTime: "12:00",
      durationHours: "2",
    }, ACTOR));
    const draft = {
      employeeId: emp.id,
      programId: dayHab,
      individualIds: [ind.id],
      frequency: "weekly" as const,
      weekdays: [1],
      startDate: "2025-03-10",
      endDate: "2025-03-24",
      startTime: "09:00",
      endTime: "11:00",
      durationHours: "2",
    };

    const rejected = await createSeries(pool, draft, ACTOR);
    expect(rejected).toMatchObject({
      ok: false,
      code: "validation",
      message: expect.stringMatching(/written override reason/i),
    });
    expect(Number(await scalar<string>(`SELECT count(*)::text FROM schedule_series`, []))).toBe(0);

    const approved = unwrap(await createSeries(pool, draft, ACTOR, "family approved the overlap"));
    expect(approved.created).toBe(3);
    expect(approved.warnings).toBeGreaterThan(0);
  });

  it("warns when the employee is not assigned to the individual", async () => {
    const { dayHab, emp } = await fixture();
    const stranger = unwrap(await createIndividual(pool, { displayName: "Unassigned Person" }, ACTOR));
    const res = unwrap(await createSession(pool, { employeeId: emp.id, programId: dayHab, individualIds: [stranger.id], sessionDate: "2025-03-10", durationHours: "1", startTime: null, endTime: null }, ACTOR, "temporary staffing exception"));
    expect(res.warnings.map((w) => w.code)).toContain("not_assigned");
  });

  it("uses assignment effective dates when checking schedule eligibility", async () => {
    const { dayHab, ind, emp } = await fixture();
    await pool.query(
      `UPDATE assignments SET start_date = '2025-01-01', end_date = '2025-02-28'
       WHERE employee_id = $1 AND individual_id = $2 AND program_id = $3`,
      [emp.id, ind.id, dayHab],
    );

    const during = await detectConflicts(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      sessionDate: "2025-02-10", durationHours: "1", startTime: null, endTime: null,
    });
    expect(during.map((warning) => warning.code)).not.toContain("not_assigned");

    const after = await detectConflicts(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      sessionDate: "2025-03-10", durationHours: "1", startTime: null, endTime: null,
    });
    expect(after.map((warning) => warning.code)).toContain("not_assigned");
  });

  it("contains actual and scheduled forecasts to the selected authorization period", async () => {
    const { dayHab, ind, emp } = await fixture();
    const insideActual = await pool.query<{ id: string }>(
      `INSERT INTO service_sessions
         (employee_id, program_id, period_begin, period_end, physical_hours)
       VALUES ($1, $2, '2025-05-01', '2025-05-15', 20) RETURNING id`,
      [emp.id, dayHab],
    );
    const outsideActual = await pool.query<{ id: string }>(
      `INSERT INTO service_sessions
         (employee_id, program_id, period_begin, period_end, physical_hours)
       VALUES ($1, $2, '2024-05-01', '2024-05-15', 50) RETURNING id`,
      [emp.id, dayHab],
    );
    await pool.query(
      `INSERT INTO service_allocations
         (service_session_id, individual_id, allocation_hours, allocated_rate, allocated_amount)
       VALUES ($1, $3, 20, 17, 340), ($2, $3, 50, 17, 850)`,
      [insideActual.rows[0].id, outsideActual.rows[0].id, ind.id],
    );
    await createSession(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      sessionDate: "2025-06-10", durationHours: "10", startTime: null, endTime: null,
    }, ACTOR);
    await createSession(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      sessionDate: "2026-06-10", durationHours: "30", startTime: null, endTime: null,
    }, ACTOR, "outside the test authorization by design");

    const forecast = await individualProgramForecast(pool, ind.id, dayHab, null, "2025-06-15");
    expect(dec(forecast.actualHours).toNumber()).toBe(20);
    expect(dec(forecast.actualAmount).toNumber()).toBe(340);
    expect(dec(forecast.scheduledHours).toNumber()).toBe(10);
    expect(dec(forecast.remainingAfterScheduleHours!).toNumber()).toBe(70);

    const withoutAuthorization = await individualProgramForecast(pool, ind.id, dayHab, null, "2026-06-15");
    expect(withoutAuthorization.authorizedHours).toBeNull();
    expect(dec(withoutAuthorization.actualHours).toNumber()).toBe(0);
    expect(dec(withoutAuthorization.scheduledHours).toNumber()).toBe(0);
  });

  it("warns when no rate is configured for the program on that date", async () => {
    const ind = unwrap(await createIndividual(pool, { displayName: "Rate Test" }, ACTOR));
    // A brand-new program with a rate only from 2026 -> a 2025 session has no rate.
    const { rows } = await pool.query<{ id: string }>(`INSERT INTO programs (code, name) VALUES ('NEWP','New Program') RETURNING id`);
    const p = rows[0].id;
    await addProgramRate(pool, p, { effectiveFrom: "2026-01-01", internalRate: "20" }, ACTOR);
    const res = unwrap(await createSession(pool, { programId: p, individualIds: [ind.id], sessionDate: "2025-06-01", durationHours: "2", employeeId: null, startTime: null, endTime: null }, ACTOR, "missing setup is the test case"));
    expect(res.warnings.map((w) => w.code)).toContain("missing_rate");
    // no rate -> no expected billing, but the session and allocation still exist.
    const gross = await scalar<string | null>(`SELECT expected_agency_gross::text FROM scheduled_sessions WHERE id=$1`, [res.id]);
    expect(gross).toBeNull();
  });

  it("expands a recurring weekly series and cancels it", async () => {
    const { dayHab, ind, emp } = await fixture();
    const today = await scalar<string>(`SELECT CURRENT_DATE::text`, []);
    const start = addDays(today, 1);
    const weekday = new Date(`${start}T00:00:00Z`).getUTCDay();
    const series = unwrap(await createSeries(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      frequency: "weekly", weekdays: [weekday], startDate: start, endDate: addDays(start, 28),
      startTime: "09:00", endTime: "11:00", durationHours: "2",
    }, ACTOR, "dynamic dates may be outside the fixed fixture authorization"));
    expect(series.created).toBe(5);
    const before = await scalar<string>(`SELECT count(*)::text FROM scheduled_sessions WHERE series_id=$1 AND status='pending'`, [series.seriesId]);
    expect(Number(before)).toBe(5);
    const owners = await testPool().query<{ individual_id: string }>(
      `SELECT individual_id::text FROM schedule_series_individuals WHERE series_id = $1`,
      [series.seriesId],
    );
    expect(owners.rows.map((row) => row.individual_id)).toEqual([ind.id]);

    const cancelled = unwrap(await cancelSeries(pool, series.seriesId, ACTOR, "family paused"));
    expect(cancelled.cancelled).toBe(5);
    const pending = await scalar<string>(`SELECT count(*)::text FROM scheduled_sessions WHERE series_id=$1 AND status='pending'`, [series.seriesId]);
    expect(Number(pending)).toBe(0);
    const missing = await cancelSeries(pool, "00000000-0000-4000-8000-000000000099", ACTOR);
    expect(missing).toMatchObject({ ok: false, code: "not_found" });
  });

  it("updates only pending future occurrences and owns the current participant roster", async () => {
    const { dayHab, ind, emp } = await fixture();
    const today = await scalar<string>(`SELECT CURRENT_DATE::text`, []);
    const yesterday = addDays(today, -1);
    const tomorrow = addDays(today, 1);
    const originalEnd = addDays(today, 3);
    const updatedEnd = addDays(today, 5);
    const series = unwrap(await createSeries(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      frequency: "daily", interval: 1, startDate: yesterday, endDate: originalEnd,
      startTime: "09:00", endTime: "11:00", durationHours: "2",
    }, ACTOR, "dynamic dates may be outside the fixed fixture authorization"));
    const initial = await testPool().query<{ id: string; session_date: string }>(
      `SELECT id, session_date::text FROM scheduled_sessions WHERE series_id = $1 ORDER BY session_date`,
      [series.seriesId],
    );
    const initialByDate = new Map(initial.rows.map((row) => [row.session_date, row.id]));
    unwrap(await setSessionStatus(pool, initialByDate.get(today)!, "completed", ACTOR));

    const second = unwrap(await createIndividual(pool, { displayName: "Bella Stern" }, ACTOR));
    const replacement = unwrap(await createEmployee(pool, { displayName: "David Weiss" }, ACTOR));
    unwrap(await createAssignment(pool, { employeeId: replacement.id, individualId: ind.id, programId: dayHab }, ACTOR));
    unwrap(await createAssignment(pool, { employeeId: replacement.id, individualId: second.id, programId: dayHab }, ACTOR));
    const secondPeriod = unwrap(await createBudgetPeriod(pool, {
      individualId: second.id, label: "Current", startDate: yesterday, endDate: addDays(today, 365),
    }, ACTOR));
    unwrap(await createAuthorization(pool, {
      budgetPeriodId: secondPeriod.id, programId: dayHab, authorizedHours: "100", internalRate: "17",
    }, ACTOR));

    const updated = unwrap(await updateSeries(pool, series.seriesId, {
      employeeId: replacement.id, programId: dayHab, individualIds: [ind.id, second.id, second.id],
      frequency: "daily", interval: 1, startDate: yesterday, endDate: updatedEnd,
      startTime: "13:00", endTime: "15:00", durationHours: "2", status: "active",
      serviceType: "Day Hab", notes: "Afternoon plan",
    }, ACTOR, "new afternoon schedule"));
    expect(updated.applyFromDate).toBe(today);
    expect(updated.split).toBe(false);
    expect(updated.previousSeriesId).toBeNull();
    expect(updated.replaced).toBe(3);
    expect(updated.preserved).toBe(2);
    expect(updated.created).toBe(5);

    const after = await testPool().query<{
      id: string; session_date: string; employee_id: string | null; start_time: string | null;
      duration_hours: string; status: string;
    }>(
      `SELECT id, session_date::text, employee_id, start_time, duration_hours::text, status
         FROM scheduled_sessions WHERE series_id = $1 ORDER BY session_date, status`,
      [series.seriesId],
    );
    const past = after.rows.find((row) => row.session_date === yesterday)!;
    expect(past.id).toBe(initialByDate.get(yesterday));
    expect(past.employee_id).toBe(emp.id);
    expect(past.start_time).toBe("09:00");
    const completed = after.rows.filter((row) => row.session_date === today);
    expect(completed).toHaveLength(1);
    expect(completed[0].id).toBe(initialByDate.get(today));
    expect(completed[0].status).toBe("completed");
    expect(after.rows.some((row) => row.id === initialByDate.get(tomorrow))).toBe(false);

    const regenerated = after.rows.filter((row) => row.session_date > today);
    expect(regenerated.map((row) => row.session_date)).toEqual([
      addDays(today, 1), addDays(today, 2), addDays(today, 3), addDays(today, 4), addDays(today, 5),
    ]);
    expect(regenerated.every((row) => row.employee_id === replacement.id)).toBe(true);
    expect(regenerated.every((row) => row.start_time === "13:00" && Number(row.duration_hours) === 2)).toBe(true);

    const roster = await testPool().query<{ individual_id: string }>(
      `SELECT individual_id::text FROM schedule_series_individuals WHERE series_id = $1 ORDER BY individual_id`,
      [series.seriesId],
    );
    expect(roster.rows.map((row) => row.individual_id).sort()).toEqual([ind.id, second.id].sort());
    const allocations = await scalar<string>(
      `SELECT count(*)::text
         FROM scheduled_allocations a
         JOIN scheduled_sessions s ON s.id = a.scheduled_session_id
        WHERE s.series_id = $1 AND s.session_date > $2::date`,
      [series.seriesId, today],
    );
    expect(Number(allocations)).toBe(10);
    const audit = await testPool().query<{ reason: string | null; metadata: Record<string, unknown> }>(
      `SELECT reason, metadata FROM audit_logs
        WHERE entity_type = 'schedule_series' AND entity_id = $1 AND action = 'series_updated'`,
      [series.seriesId],
    );
    expect(audit.rows[0].reason).toBe("new afternoon schedule");
    expect(audit.rows[0].metadata).toMatchObject({ replaced: 3, created: 5, preserved: 2 });
  });

  it("rolls back an edited series with live warnings until a reason is supplied", async () => {
    const { dayHab, ind, emp } = await fixture();
    const today = await scalar<string>(`SELECT CURRENT_DATE::text`, []);
    const start = addDays(today, 1);
    const conflictDate = addDays(today, 2);
    const end = addDays(today, 3);
    await pool.query(
      `UPDATE budget_periods
          SET start_date = $2::date, end_date = $3::date
        WHERE individual_id = $1`,
      [ind.id, addDays(today, -30), addDays(today, 30)],
    );
    const series = unwrap(await createSeries(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      frequency: "daily", startDate: start, endDate: end,
      startTime: "09:00", endTime: "10:00", durationHours: "1",
    }, ACTOR));
    unwrap(await createSession(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      sessionDate: conflictDate, startTime: "12:00", endTime: "14:00", durationHours: "2",
    }, ACTOR));
    const edit = {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      frequency: "daily" as const, startDate: start, endDate: end,
      startTime: "13:00", endTime: "15:00", durationHours: "2", status: "active" as const,
    };

    const rejected = await updateSeries(pool, series.seriesId, edit, ACTOR);
    expect(rejected).toMatchObject({
      ok: false,
      code: "validation",
      message: expect.stringMatching(/written override reason/i),
    });
    expect(await scalar<string>(`SELECT start_time FROM schedule_series WHERE id = $1`, [series.seriesId])).toBe("09:00");

    const approved = unwrap(await updateSeries(pool, series.seriesId, edit, ACTOR, "approved recurring overlap"));
    expect(approved.warnings).toBeGreaterThan(0);
    expect(await scalar<string>(`SELECT start_time FROM schedule_series WHERE id = $1`, [series.seriesId])).toBe("13:00");
  });

  it("rolls back a future-series replacement when any new participant is invalid", async () => {
    const { dayHab, ind, emp } = await fixture();
    const today = await scalar<string>(`SELECT CURRENT_DATE::text`, []);
    const start = addDays(today, 1);
    const end = addDays(today, 3);
    const series = unwrap(await createSeries(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      frequency: "daily", startDate: start, endDate: end,
      startTime: "09:00", endTime: "11:00", durationHours: "2",
    }, ACTOR, "dynamic dates may be outside the fixed fixture authorization"));
    const before = await testPool().query<{ id: string }>(
      `SELECT id FROM scheduled_sessions WHERE series_id = $1 ORDER BY session_date`, [series.seriesId],
    );
    const failed = await updateSeries(pool, series.seriesId, {
      employeeId: emp.id, programId: dayHab,
      individualIds: ["00000000-0000-4000-8000-000000000099"],
      frequency: "daily", startDate: start, endDate: addDays(today, 5),
      startTime: "12:00", endTime: "14:00", durationHours: "2", status: "active",
    }, ACTOR);
    expect(failed).toMatchObject({
      ok: false,
      message: "A selected employee, individual, or program is no longer available. Refresh and try again.",
    });

    const after = await testPool().query<{ id: string }>(
      `SELECT id FROM scheduled_sessions WHERE series_id = $1 ORDER BY session_date`, [series.seriesId],
    );
    expect(after.rows.map((row) => row.id)).toEqual(before.rows.map((row) => row.id));
    expect(await scalar<string>(`SELECT start_time FROM schedule_series WHERE id = $1`, [series.seriesId])).toBe("09:00");
    const owners = await testPool().query<{ individual_id: string }>(
      `SELECT individual_id::text FROM schedule_series_individuals WHERE series_id = $1`, [series.seriesId],
    );
    expect(owners.rows.map((row) => row.individual_id)).toEqual([ind.id]);
  });

  it("creates a linked future version without resetting recurrence phase", async () => {
    const { dayHab, ind, emp } = await fixture();
    const today = await scalar<string>(`SELECT CURRENT_DATE::text`, []);
    const start = today;
    const applyFrom = addDays(today, 3);
    const protectedDate = addDays(today, 4);
    const end = addDays(today, 8);
    const series = unwrap(await createSeries(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      frequency: "daily", interval: 2, startDate: start, endDate: end,
      startTime: "09:00", endTime: "11:00", durationHours: "2",
    }, ACTOR, "dynamic dates may be outside the fixed fixture authorization"));
    const protectedSessionId = await scalar<string>(
      `SELECT id FROM scheduled_sessions WHERE series_id = $1 AND session_date = $2::date`,
      [series.seriesId, protectedDate],
    );
    unwrap(await setSessionStatus(pool, protectedSessionId, "completed", ACTOR));

    const second = unwrap(await createIndividual(pool, { displayName: "Future Participant" }, ACTOR));
    const replacement = unwrap(await createEmployee(pool, { displayName: "Future Employee" }, ACTOR));

    const updated = unwrap(await updateSeries(pool, series.seriesId, {
      employeeId: replacement.id, programId: dayHab, individualIds: [ind.id, second.id],
      frequency: "daily", interval: 2, startDate: start, endDate: end,
      startTime: "13:00", endTime: "15:00", durationHours: "2", status: "active",
      applyFromDate: applyFrom,
    }, ACTOR, "future version test intentionally changes staffing"));
    expect(updated.applyFromDate).toBe(applyFrom);
    expect(updated.split).toBe(true);
    expect(updated.previousSeriesId).toBe(series.seriesId);
    expect(updated.seriesId).not.toBe(series.seriesId);
    expect(updated.replaced).toBe(2);
    expect(updated.created).toBe(2);

    const duplicateVersion = await updateSeries(pool, series.seriesId, {
      employeeId: replacement.id, programId: dayHab, individualIds: [ind.id, second.id],
      frequency: "daily", interval: 2, startDate: start, endDate: end,
      startTime: "15:00", endTime: "17:00", durationHours: "2", status: "active",
      applyFromDate: addDays(applyFrom, 1),
    }, ACTOR);
    expect(duplicateVersion).toMatchObject({
      ok: false,
      code: "conflict",
      message: expect.stringMatching(/edit the upcoming version/i),
    });

    const versions = await testPool().query<{
      id: string; supersedes_series_id: string | null; recurrence_anchor_date: string;
      start_date: string; end_date: string; status: string;
    }>(
      `SELECT id, supersedes_series_id, recurrence_anchor_date::text,
              start_date::text, end_date::text, status
         FROM schedule_series
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[series.seriesId, updated.seriesId]],
    );
    const oldVersion = versions.rows.find((row) => row.id === series.seriesId)!;
    const newVersion = versions.rows.find((row) => row.id === updated.seriesId)!;
    expect(oldVersion).toMatchObject({ end_date: addDays(applyFrom, -1), status: "active" });
    expect(newVersion).toMatchObject({
      supersedes_series_id: series.seriesId,
      recurrence_anchor_date: start,
      start_date: applyFrom,
      end_date: end,
      status: "active",
    });

    const oldRows = await testPool().query<{ session_date: string; start_time: string; status: string }>(
      `SELECT session_date::text, start_time::text, status
         FROM scheduled_sessions
        WHERE series_id = $1
        ORDER BY session_date`,
      [series.seriesId],
    );
    expect(oldRows.rows.find((row) => row.session_date === protectedDate)).toMatchObject({ status: "completed" });
    expect(oldRows.rows.filter((row) => row.session_date >= applyFrom && row.session_date !== protectedDate)
      .every((row) => row.status === "cancelled")).toBe(true);
    const newRows = await testPool().query<{ session_date: string; start_time: string }>(
      `SELECT session_date::text, start_time::text FROM scheduled_sessions
        WHERE series_id = $1 ORDER BY session_date`,
      [updated.seriesId],
    );
    expect(newRows.rows).toEqual([
      { session_date: addDays(today, 6), start_time: "13:00" },
      { session_date: addDays(today, 8), start_time: "13:00" },
    ]);
    const defaultCalendar = await listSessions(pool, { from: applyFrom, to: end });
    expect(defaultCalendar.filter((row) => row.status === "cancelled")).toHaveLength(0);
    expect(defaultCalendar.filter((row) => row.seriesId === updated.seriesId).map((row) => row.sessionDate)).toEqual([
      addDays(today, 6),
      addDays(today, 8),
    ]);
    const cancelledAudit = await listSessions(pool, { from: applyFrom, to: end, status: "cancelled" });
    expect(cancelledAudit).toHaveLength(2);
    expect(cancelledAudit.every((row) => row.seriesId === series.seriesId)).toBe(true);
    const oldOwners = await testPool().query<{ individual_id: string }>(
      `SELECT individual_id::text FROM schedule_series_individuals WHERE series_id = $1`,
      [series.seriesId],
    );
    const newOwners = await testPool().query<{ individual_id: string }>(
      `SELECT individual_id::text FROM schedule_series_individuals WHERE series_id = $1 ORDER BY individual_id`,
      [updated.seriesId],
    );
    expect(oldOwners.rows.map((row) => row.individual_id)).toEqual([ind.id]);
    expect(newOwners.rows.map((row) => row.individual_id).sort()).toEqual([ind.id, second.id].sort());
    const versionAudit = await testPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs
        WHERE entity_id = $1 AND action = 'series_version_created'`,
      [updated.seriesId],
    );
    expect(versionAudit.rows[0].metadata).toMatchObject({
      previousSeriesId: series.seriesId,
      newSeriesId: updated.seriesId,
      applyFromDate: applyFrom,
    });
  });

  it("serializes concurrent future edits into one upcoming version", async () => {
    const { dayHab, ind, emp } = await fixture();
    const today = await scalar<string>(`SELECT CURRENT_DATE::text`, []);
    const start = today;
    const applyFrom = addDays(today, 2);
    const end = addDays(today, 6);
    const series = unwrap(await createSeries(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      frequency: "daily", startDate: start, endDate: end,
      startTime: "09:00", endTime: "11:00", durationHours: "2",
    }, ACTOR, "dynamic dates may be outside the fixed fixture authorization"));
    const edit = {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      frequency: "daily" as const, interval: 1, startDate: start, endDate: end,
      startTime: "12:00", endTime: "14:00", durationHours: "2", status: "active" as const,
      applyFromDate: applyFrom,
    };

    const results = await Promise.all([
      updateSeries(pool, series.seriesId, edit, ACTOR, "concurrent approved edit"),
      updateSeries(pool, series.seriesId, edit, ACTOR, "concurrent approved edit"),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/edit the upcoming version/i),
    });
    const successorCount = await scalar<string>(
      `SELECT count(*)::text FROM schedule_series
        WHERE supersedes_series_id = $1 AND archived_at IS NULL`,
      [series.seriesId],
    );
    expect(Number(successorCount)).toBe(1);
  });

  it("preserves past and matched occurrences when ending a series", async () => {
    const { dayHab, ind, emp } = await fixture();
    const today = await scalar<string>(`SELECT CURRENT_DATE::text`, []);
    const series = unwrap(await createSeries(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      frequency: "daily", startDate: addDays(today, -1), endDate: addDays(today, 2),
      startTime: "09:00", endTime: "11:00", durationHours: "2",
    }, ACTOR, "dynamic dates may be outside the fixed fixture authorization"));
    const matchedDate = addDays(today, 1);
    const matchedId = await scalar<string>(
      `SELECT id FROM scheduled_sessions WHERE series_id = $1 AND session_date = $2::date`,
      [series.seriesId, matchedDate],
    );
    const transaction = await testPool().query<{ id: string }>(
      `INSERT INTO payroll_transactions (employee_id, individual_id, transaction_fingerprint)
       VALUES ($1, $2, 'matched-series-cancel') RETURNING id`,
      [emp.id, ind.id],
    );
    await pool.query(
      `UPDATE scheduled_sessions SET matched_transaction_id = $2 WHERE id = $1`,
      [matchedId, transaction.rows[0].id],
    );

    const cancelled = unwrap(await cancelSeries(pool, series.seriesId, ACTOR));
    expect(cancelled.cancelled).toBe(2);
    const rows = await testPool().query<{ session_date: string; status: string; matched_transaction_id: string | null }>(
      `SELECT session_date::text, status, matched_transaction_id
         FROM scheduled_sessions WHERE series_id = $1 ORDER BY session_date`,
      [series.seriesId],
    );
    expect(rows.rows.find((row) => row.session_date === addDays(today, -1))).toMatchObject({ status: "pending" });
    expect(rows.rows.find((row) => row.session_date === matchedDate)).toMatchObject({
      status: "pending", matched_transaction_id: transaction.rows[0].id,
    });
    expect(rows.rows.filter((row) => row.session_date >= today && row.session_date !== matchedDate)
      .every((row) => row.status === "cancelled")).toBe(true);
  });

  it("keeps matched sessions available to reconciliation", async () => {
    const { dayHab, ind, emp } = await fixture();
    const today = await scalar<string>(`SELECT CURRENT_DATE::text`, []);
    const sessionDate = addDays(today, 1);
    const session = unwrap(await createSession(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id], sessionDate,
      startTime: "09:00", endTime: "11:00", durationHours: "2",
    }, ACTOR, "dynamic date may be outside the fixed fixture authorization"));
    const transaction = await testPool().query<{ id: string }>(
      `INSERT INTO payroll_transactions (employee_id, individual_id, transaction_fingerprint)
       VALUES ($1, $2, 'matched-session-guard') RETURNING id`,
      [emp.id, ind.id],
    );
    await pool.query(
      `UPDATE scheduled_sessions SET matched_transaction_id = $2 WHERE id = $1`,
      [session.id, transaction.rows[0].id],
    );

    expect(await setSessionStatus(pool, session.id, "cancelled", ACTOR)).toMatchObject({
      ok: false, code: "immutable",
    });
    expect(await setSessionStatus(pool, session.id, "no_show", ACTOR)).toMatchObject({
      ok: false, code: "immutable",
    });
    expect(await rescheduleSession(pool, session.id, { sessionDate: addDays(today, 2) }, ACTOR)).toMatchObject({
      ok: false, code: "immutable",
    });
    expect(await scalar<string>(`SELECT status FROM scheduled_sessions WHERE id = $1`, [session.id])).toBe("pending");
    expect(await scalar<string>(`SELECT session_date::text FROM scheduled_sessions WHERE id = $1`, [session.id])).toBe(sessionDate);
    unwrap(await setSessionStatus(pool, session.id, "completed", ACTOR));
    expect(await scalar<string>(`SELECT status FROM scheduled_sessions WHERE id = $1`, [session.id])).toBe("completed");
  });

  it("marks status, reschedules (re-checking conflicts), and duplicates", async () => {
    const { dayHab, ind, emp } = await fixture();
    const s = unwrap(await createSession(pool, { employeeId: emp.id, programId: dayHab, individualIds: [ind.id], sessionDate: "2025-03-10", startTime: "09:00", endTime: "11:00", durationHours: "2" }, ACTOR));
    unwrap(await setSessionStatus(pool, s.id, "completed", ACTOR));
    expect(await scalar<string>(`SELECT status FROM scheduled_sessions WHERE id=$1`, [s.id])).toBe("completed");

    const moved = unwrap(await rescheduleSession(pool, s.id, { sessionDate: "2025-03-12" }, ACTOR, "clinic closed"));
    expect(await scalar<string>(`SELECT session_date::text FROM scheduled_sessions WHERE id=$1`, [s.id])).toBe("2025-03-12");
    expect(Array.isArray(moved.warnings)).toBe(true);

    const dup = unwrap(await duplicateSession(pool, s.id, "2025-03-19", ACTOR));
    expect(dup.id).not.toBe(s.id);
  });

  it("aggregates scheduled hours for the three-way budget and the dashboard", async () => {
    const { dayHab, ind, emp } = await fixture();
    const matched = unwrap(await createSession(pool, { employeeId: emp.id, programId: dayHab, individualIds: [ind.id], sessionDate: "2025-04-01", durationHours: "5", startTime: null, endTime: null }, ACTOR));
    await createSession(pool, { employeeId: emp.id, programId: dayHab, individualIds: [ind.id], sessionDate: "2025-04-08", durationHours: "5", startTime: null, endTime: null }, ACTOR);

    const actual = await pool.query<{ id: string }>(
      `INSERT INTO service_sessions
         (employee_id, program_id, period_begin, period_end, physical_hours)
       VALUES ($1, $2, '2025-04-01', '2025-04-01', 5) RETURNING id`,
      [emp.id, dayHab],
    );
    await pool.query(
      `INSERT INTO service_allocations
         (service_session_id, individual_id, allocation_hours, allocated_rate, allocated_amount)
       VALUES ($1, $2, 5, 17, 85)`,
      [actual.rows[0].id, ind.id],
    );
    const transaction = await pool.query<{ id: string }>(
      `INSERT INTO payroll_transactions (employee_id, individual_id, transaction_fingerprint)
       VALUES ($1, $2, 'matched-forecast-does-not-double-count') RETURNING id`,
      [emp.id, ind.id],
    );
    await pool.query(
      `UPDATE scheduled_sessions SET matched_transaction_id = $2 WHERE id = $1`,
      [matched.id, transaction.rows[0].id],
    );

    const byProg = await scheduledByProgramForIndividual(pool, ind.id);
    expect(dec(byProg.DAY_HAB.hours).toNumber()).toBe(5);
    expect(dec(byProg.DAY_HAB.internal).toNumber()).toBe(85);

    const totals = await scheduledTotals(pool);
    expect(totals.sessions).toBe(1);
    expect(dec(totals.hours).toNumber()).toBe(5);

    const forecast = await individualProgramForecast(pool, ind.id, dayHab, null, "2025-04-15");
    expect(dec(forecast.actualHours).toNumber()).toBe(5);
    expect(dec(forecast.scheduledHours).toNumber()).toBe(5);
    expect(dec(forecast.remainingAfterScheduleHours!).toNumber()).toBe(90);

    const cal = await listSessions(pool, { from: "2025-04-01", to: "2025-04-30" });
    expect(cal).toHaveLength(2);
    expect(cal[0].individualNames).toContain("Aaron Levy");
    expect(Object.keys(cal[0]).sort()).toEqual([
      "canChangeSchedule", "durationHours", "employeeId", "employeeName", "endTime", "groupSize",
      "id", "individualIds", "individualNames", "isGroup", "programId", "programName",
      "seriesId", "sessionDate", "startTime", "status", "warningCount",
    ].sort());
    expect(cal.find((row) => row.id === matched.id)).toMatchObject({
      status: "completed",
      canChangeSchedule: false,
    });
    expect(await listSessions(pool, { from: "2025-04-01", to: "2025-04-30", status: "pending" })).toHaveLength(1);
    expect(await listSessions(pool, { from: "2025-04-01", to: "2025-04-30", status: "completed" })).toHaveLength(1);
    const unassignedOnly = await listSessions(pool, { from: "2025-04-01", to: "2025-04-30", unassigned: true });
    expect(unassignedOnly).toHaveLength(0);
  });
});
