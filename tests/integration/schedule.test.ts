import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { hasTestDatabase, testPool, resetSchema, truncateBusinessTables, closeTestPool } from "../support/database";
import type { PgLikePool } from "@/lib/import/commit";
import { createIndividual } from "@/lib/manage/individuals";
import { createEmployee } from "@/lib/manage/employees";
import { createAssignment } from "@/lib/manage/assignments";
import { createBudgetPeriod, createAuthorization } from "@/lib/manage/authorizations";
import { addProgramRate } from "@/lib/manage/programs";
import {
  createSession, createSeries, setSessionStatus, rescheduleSession, duplicateSession, cancelSeries, detectConflicts,
} from "@/lib/manage/schedule";
import { listSessions, scheduledByProgramForIndividual, scheduledTotals } from "@/lib/data/schedule-queries";
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
    }, ACTOR));
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

  it("warns when scheduling exceeds the remaining authorization", async () => {
    const { dayHab, ind, emp } = await fixture(); // 100 authorized
    const res = unwrap(await createSession(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      sessionDate: "2025-03-10", durationHours: "120", startTime: null, endTime: null,
    }, ACTOR));
    expect(res.warnings.map((w) => w.code)).toContain("over_authorized_hours");
  });

  it("warns on employee double-booking and outside-authorization dates", async () => {
    const { dayHab, ind, emp } = await fixture();
    await createSession(pool, { employeeId: emp.id, programId: dayHab, individualIds: [ind.id], sessionDate: "2025-03-10", startTime: "09:00", endTime: "12:00", durationHours: "3" }, ACTOR);
    const second = unwrap(await createSession(pool, { employeeId: emp.id, programId: dayHab, individualIds: [ind.id], sessionDate: "2025-03-10", startTime: "10:00", endTime: "13:00", durationHours: "3" }, ACTOR));
    expect(second.warnings.map((w) => w.code)).toContain("employee_double_booked");

    const outside = await detectConflicts(pool, { employeeId: emp.id, programId: dayHab, individualIds: [ind.id], sessionDate: "2027-01-01", startTime: null, endTime: null, durationHours: "1" });
    expect(outside.map((w) => w.code)).toContain("outside_authorization_dates");
  });

  it("warns when the employee is not assigned to the individual", async () => {
    const { dayHab, emp } = await fixture();
    const stranger = unwrap(await createIndividual(pool, { displayName: "Unassigned Person" }, ACTOR));
    const res = unwrap(await createSession(pool, { employeeId: emp.id, programId: dayHab, individualIds: [stranger.id], sessionDate: "2025-03-10", durationHours: "1", startTime: null, endTime: null }, ACTOR));
    expect(res.warnings.map((w) => w.code)).toContain("not_assigned");
  });

  it("warns when no rate is configured for the program on that date", async () => {
    const ind = unwrap(await createIndividual(pool, { displayName: "Rate Test" }, ACTOR));
    // A brand-new program with a rate only from 2026 -> a 2025 session has no rate.
    const { rows } = await pool.query<{ id: string }>(`INSERT INTO programs (code, name) VALUES ('NEWP','New Program') RETURNING id`);
    const p = rows[0].id;
    await addProgramRate(pool, p, { effectiveFrom: "2026-01-01", internalRate: "20" }, ACTOR);
    const res = unwrap(await createSession(pool, { programId: p, individualIds: [ind.id], sessionDate: "2025-06-01", durationHours: "2", employeeId: null, startTime: null, endTime: null }, ACTOR));
    expect(res.warnings.map((w) => w.code)).toContain("missing_rate");
    // no rate -> no expected billing, but the session and allocation still exist.
    const gross = await scalar<string | null>(`SELECT expected_agency_gross::text FROM scheduled_sessions WHERE id=$1`, [res.id]);
    expect(gross).toBeNull();
  });

  it("expands a recurring weekly series and cancels it", async () => {
    const { dayHab, ind, emp } = await fixture();
    const series = unwrap(await createSeries(pool, {
      employeeId: emp.id, programId: dayHab, individualIds: [ind.id],
      frequency: "weekly", weekdays: [1], startDate: "2025-03-03", endDate: "2025-03-31",
      startTime: "09:00", endTime: "11:00", durationHours: "2",
    }, ACTOR));
    expect(series.created).toBe(5); // Mondays: 3,10,17,24,31
    const before = await scalar<string>(`SELECT count(*)::text FROM scheduled_sessions WHERE series_id=$1 AND status='pending'`, [series.seriesId]);
    expect(Number(before)).toBe(5);

    unwrap(await cancelSeries(pool, series.seriesId, ACTOR, "family paused"));
    const pending = await scalar<string>(`SELECT count(*)::text FROM scheduled_sessions WHERE series_id=$1 AND status='pending'`, [series.seriesId]);
    expect(Number(pending)).toBe(0);
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
    await createSession(pool, { employeeId: emp.id, programId: dayHab, individualIds: [ind.id], sessionDate: "2025-04-01", durationHours: "5", startTime: null, endTime: null }, ACTOR);
    await createSession(pool, { employeeId: emp.id, programId: dayHab, individualIds: [ind.id], sessionDate: "2025-04-08", durationHours: "5", startTime: null, endTime: null }, ACTOR);
    const byProg = await scheduledByProgramForIndividual(pool, ind.id);
    expect(dec(byProg.DAY_HAB.hours).toNumber()).toBe(10);
    expect(dec(byProg.DAY_HAB.internal).toNumber()).toBe(170); // 10 x 17

    const totals = await scheduledTotals(pool);
    expect(totals.sessions).toBe(2);
    expect(dec(totals.hours).toNumber()).toBe(10);

    const cal = await listSessions(pool, { from: "2025-04-01", to: "2025-04-30" });
    expect(cal).toHaveLength(2);
    expect(cal[0].individualNames).toContain("Aaron Levy");
    const unassignedOnly = await listSessions(pool, { from: "2025-04-01", to: "2025-04-30", unassigned: true });
    expect(unassignedOnly).toHaveLength(0);
  });
});
