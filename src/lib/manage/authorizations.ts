import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";
import { toMoney, toHours } from "@/lib/money";

/**
 * Authorizations, with full revision history.
 *
 * A budget PERIOD is a date range for one individual. Inside it, an
 * AUTHORIZATION grants hours (and optionally dollars) for one program. Editing
 * an authorization never overwrites: it supersedes the prior row and writes a
 * new revision, so the history is preserved. Exactly one revision per
 * (period, program) is `active` at a time.
 */

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

export interface BudgetPeriodRecord {
  id: string;
  individualId: string;
  label: string;
  startDate: string;
  endDate: string;
  status: string;
  source: string | null;
  notes: string | null;
}

export async function createBudgetPeriod(
  pool: PgLikePool,
  input: { individualId: string; label: string; startDate: string; endDate: string; notes?: string | null; source?: string | null },
  actorId: string | null,
  reason?: string | null,
): Promise<Result<BudgetPeriodRecord>> {
  if (!isUuid(input.individualId)) return fail("validation", "Choose an individual.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) {
    return fail("validation", "Give start and end dates (YYYY-MM-DD).");
  }
  if (input.endDate < input.startDate) return fail("validation", "The end date is before the start date.");
  const label = input.label?.trim() || `${input.startDate} to ${input.endDate}`;

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO budget_periods (individual_id, label, start_date, end_date, notes, source)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.individualId, label, input.startDate, input.endDate, input.notes?.trim() || null, input.source ?? "manual"],
  );
  const period = await getBudgetPeriod(pool, rows[0]!.id);
  await recordChange(pool, {
    actorId,
    action: "budget_period_created",
    entityType: "budget_period",
    entityId: rows[0]!.id,
    next: period,
    reason,
  });
  return ok(period!);
}

export async function getBudgetPeriod(pool: PgLikePool, id: string): Promise<BudgetPeriodRecord | null> {
  if (!isUuid(id)) return null;
  const { rows } = await pool.query<{
    id: string; individual_id: string; label: string; start_date: string; end_date: string;
    status: string; source: string | null; notes: string | null;
  }>(
    `SELECT id, individual_id, label, start_date::text AS start_date, end_date::text AS end_date,
            status, source, notes FROM budget_periods WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  return r
    ? { id: r.id, individualId: r.individual_id, label: r.label, startDate: r.start_date, endDate: r.end_date, status: r.status, source: r.source, notes: r.notes }
    : null;
}

export interface AuthorizationRecord {
  id: string;
  budgetPeriodId: string;
  individualId: string;
  programId: string;
  programCode: string;
  programName: string;
  authorizedHours: string;
  authorizedDollars: string | null;
  internalRate: string;
  rateBasis: string | null;
  revision: number;
  status: string;
  supersedesId: string | null;
  notes: string | null;
  source: string | null;
  createdAt: string;
}

interface AuthRow {
  id: string;
  budget_period_id: string;
  individual_id: string;
  program_id: string;
  program_code: string;
  program_name: string;
  authorized_hours: string;
  authorized_dollars: string | null;
  internal_rate: string;
  rate_basis: string | null;
  revision: number;
  status: string;
  supersedes_id: string | null;
  notes: string | null;
  source: string | null;
  created_at: string;
}

const AUTH_SELECT = `
  SELECT a.id, a.budget_period_id, a.individual_id, a.program_id,
         p.code AS program_code, p.name AS program_name,
         a.authorized_hours::text AS authorized_hours,
         a.authorized_dollars::text AS authorized_dollars,
         a.internal_rate::text AS internal_rate,
         a.rate_basis, a.revision, a.status, a.supersedes_id, a.notes, a.source,
         a.created_at::text AS created_at
  FROM budget_authorizations a JOIN programs p ON p.id = a.program_id`;

const toAuth = (r: AuthRow): AuthorizationRecord => ({
  id: r.id,
  budgetPeriodId: r.budget_period_id,
  individualId: r.individual_id,
  programId: r.program_id,
  programCode: r.program_code,
  programName: r.program_name,
  authorizedHours: r.authorized_hours,
  authorizedDollars: r.authorized_dollars,
  internalRate: r.internal_rate,
  rateBasis: r.rate_basis,
  revision: r.revision,
  status: r.status,
  supersedesId: r.supersedes_id,
  notes: r.notes,
  source: r.source,
  createdAt: r.created_at,
});

export async function getAuthorization(pool: PgLikePool, id: string): Promise<AuthorizationRecord | null> {
  if (!isUuid(id)) return null;
  const { rows } = await pool.query<AuthRow>(`${AUTH_SELECT} WHERE a.id = $1`, [id]);
  return rows[0] ? toAuth(rows[0]) : null;
}

export interface AuthorizationInput {
  budgetPeriodId: string;
  programId: string;
  authorizedHours: string;
  internalRate: string;
  authorizedDollars?: string | null;
  rateBasis?: string | null;
  notes?: string | null;
  source?: string | null;
}

export async function createAuthorization(
  pool: PgLikePool,
  input: AuthorizationInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<AuthorizationRecord>> {
  if (!isUuid(input.budgetPeriodId) || !isUuid(input.programId)) {
    return fail("validation", "Choose a budget period and a program.");
  }
  const hours = Number(input.authorizedHours);
  const rate = Number(input.internalRate);
  if (!Number.isFinite(hours) || hours < 0) return fail("validation", "Enter valid authorized hours.");
  if (!Number.isFinite(rate) || rate < 0) return fail("validation", "Enter a valid internal rate.");

  const period = await getBudgetPeriod(pool, input.budgetPeriodId);
  if (!period) return fail("not_found", "That budget period no longer exists.");

  const existing = await pool.query(
    `SELECT id FROM budget_authorizations
      WHERE budget_period_id = $1 AND program_id = $2 AND status = 'active'`,
    [input.budgetPeriodId, input.programId],
  );
  if (existing.rows[0]) {
    return fail("conflict", "This program already has an active authorization in this period. Revise it instead.");
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO budget_authorizations
       (budget_period_id, individual_id, program_id, authorized_hours, internal_rate,
        authorized_dollars, rate_basis, notes, source, created_by_user_id, revision, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, 'active') RETURNING id`,
    [
      input.budgetPeriodId,
      period.individualId,
      input.programId,
      toHours(input.authorizedHours),
      toMoney(input.internalRate),
      input.authorizedDollars ? toMoney(input.authorizedDollars) : null,
      input.rateBasis?.trim() || "hours",
      input.notes?.trim() || null,
      input.source ?? "manual",
      actorId,
    ],
  );
  const record = await getAuthorization(pool, rows[0]!.id);
  await recordChange(pool, {
    actorId,
    action: "authorization_created",
    entityType: "authorization",
    entityId: rows[0]!.id,
    next: record,
    reason,
  });
  return ok(record!);
}

/** Supersede the current authorization with a new revision. History preserved. */
export async function reviseAuthorization(
  pool: PgLikePool,
  id: string,
  input: Partial<Pick<AuthorizationInput, "authorizedHours" | "internalRate" | "authorizedDollars" | "rateBasis" | "notes">>,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<AuthorizationRecord>> {
  const before = await getAuthorization(pool, id);
  if (!before) return fail("not_found", "That authorization no longer exists.");
  if (before.status !== "active") {
    return fail("immutable", "Only the active revision can be revised.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE budget_authorizations SET status = 'superseded', updated_at = now() WHERE id = $1`,
      [id],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO budget_authorizations
         (budget_period_id, individual_id, program_id, authorized_hours, internal_rate,
          authorized_dollars, rate_basis, notes, source, created_by_user_id, revision, status, supersedes_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12) RETURNING id`,
      [
        before.budgetPeriodId,
        before.individualId,
        before.programId,
        input.authorizedHours !== undefined ? toHours(input.authorizedHours) : toHours(before.authorizedHours),
        input.internalRate !== undefined ? toMoney(input.internalRate) : toMoney(before.internalRate),
        input.authorizedDollars !== undefined
          ? input.authorizedDollars ? toMoney(input.authorizedDollars) : null
          : before.authorizedDollars,
        input.rateBasis !== undefined ? input.rateBasis?.trim() || "hours" : before.rateBasis,
        input.notes !== undefined ? input.notes?.trim() || null : before.notes,
        before.source,
        actorId,
        before.revision + 1,
        id,
      ],
    );
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, reason, metadata)
       VALUES ($1, 'authorization_revised', 'authorization', $2, $3, $4)`,
      [actorId, rows[0]!.id, reason ?? null, JSON.stringify({ previous: before, supersedes: id, revision: before.revision + 1 })],
    );
    await client.query("COMMIT");
    return ok((await getAuthorization(pool, rows[0]!.id))!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelAuthorization(
  pool: PgLikePool,
  id: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<AuthorizationRecord>> {
  const before = await getAuthorization(pool, id);
  if (!before) return fail("not_found", "That authorization no longer exists.");
  await pool.query(
    `UPDATE budget_authorizations SET status = 'cancelled', archived_at = now(), updated_at = now() WHERE id = $1`,
    [id],
  );
  await recordChange(pool, {
    actorId,
    action: "authorization_cancelled",
    entityType: "authorization",
    entityId: id,
    previous: { status: before.status },
    next: { status: "cancelled" },
    reason,
  });
  return ok((await getAuthorization(pool, id))!);
}

/** Active authorizations plus the full revision history, for one individual. */
export async function listAuthorizationsForIndividual(
  pool: PgLikePool,
  individualId: string,
): Promise<{ periods: BudgetPeriodRecord[]; authorizations: AuthorizationRecord[] }> {
  if (!isUuid(individualId)) return { periods: [], authorizations: [] };
  const [periodsRes, authRes] = await Promise.all([
    pool.query<{
      id: string; individual_id: string; label: string; start_date: string; end_date: string;
      status: string; source: string | null; notes: string | null;
    }>(
      `SELECT id, individual_id, label, start_date::text AS start_date, end_date::text AS end_date,
              status, source, notes FROM budget_periods
       WHERE individual_id = $1 ORDER BY start_date DESC`,
      [individualId],
    ),
    pool.query<AuthRow>(`${AUTH_SELECT} WHERE a.individual_id = $1 ORDER BY a.created_at DESC`, [individualId]),
  ]);
  return {
    periods: periodsRes.rows.map((r) => ({
      id: r.id, individualId: r.individual_id, label: r.label, startDate: r.start_date,
      endDate: r.end_date, status: r.status, source: r.source, notes: r.notes,
    })),
    authorizations: authRes.rows.map(toAuth),
  };
}
