import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";
import { toMoney, toHours, tryDec } from "@/lib/money";
import { derivePeriodDates, PERIOD_TYPES, type PeriodType } from "./budget-periods";

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
  periodType: string;
  renewalDate: string | null;
  status: string;
  source: string | null;
  notes: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface CreateBudgetPeriodInput {
  individualId: string;
  label: string;
  startDate?: string | null;
  endDate?: string | null;
  /** 'calendar' | 'rolling' | 'custom'. Defaults to 'custom'. */
  periodType?: string | null;
  /** Optional year for a calendar period; taken from startDate when omitted. */
  year?: number | string | null;
  renewalDate?: string | null;
  notes?: string | null;
  source?: string | null;
}

export async function createBudgetPeriod(
  pool: PgLikePool,
  input: CreateBudgetPeriodInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<BudgetPeriodRecord>> {
  if (!isUuid(input.individualId)) return fail("validation", "Choose an individual.");

  const periodType: PeriodType = PERIOD_TYPES.includes(input.periodType as PeriodType)
    ? (input.periodType as PeriodType)
    : "custom";

  const rawStart = input.startDate?.trim() || "";
  const rawEnd = input.endDate?.trim() || "";
  const yearRaw = input.year;
  const year =
    yearRaw === undefined || yearRaw === null || yearRaw === ""
      ? null
      : Number(yearRaw);
  if (year !== null && !Number.isInteger(year)) {
    return fail("validation", "Enter a valid four-digit year.");
  }

  // Calendar periods can be created from a year alone; rolling and custom need a
  // start date. Custom keeps its explicit end date; the others derive one.
  let startDate: string;
  let endDate: string;
  if (periodType === "calendar") {
    if (year === null && !ISO_DATE.test(rawStart)) {
      return fail("validation", "Give a year or a start date for the calendar period.");
    }
    try {
      ({ startDate, endDate } = derivePeriodDates("calendar", rawStart || null, year));
    } catch (e) {
      return fail("validation", e instanceof Error ? e.message : "Could not derive the period dates.");
    }
  } else if (periodType === "rolling") {
    if (!ISO_DATE.test(rawStart)) return fail("validation", "Give a start date (YYYY-MM-DD).");
    ({ startDate, endDate } = derivePeriodDates("rolling", rawStart));
  } else {
    if (!ISO_DATE.test(rawStart) || !ISO_DATE.test(rawEnd)) {
      return fail("validation", "Give start and end dates (YYYY-MM-DD).");
    }
    startDate = rawStart;
    endDate = rawEnd;
  }

  if (endDate < startDate) return fail("validation", "The end date is before the start date.");

  const renewalDate = input.renewalDate?.trim() || null;
  if (renewalDate !== null && !ISO_DATE.test(renewalDate)) {
    return fail("validation", "The renewal date must be a date (YYYY-MM-DD).");
  }

  const label = input.label?.trim() || `${startDate} to ${endDate}`;

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO budget_periods
       (individual_id, label, start_date, end_date, period_type, renewal_date, notes, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [input.individualId, label, startDate, endDate, periodType, renewalDate, input.notes?.trim() || null, input.source ?? "manual"],
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

export async function getBudgetPeriod(pool: Queryable, id: string): Promise<BudgetPeriodRecord | null> {
  if (!isUuid(id)) return null;
  const { rows } = await pool.query<{
    id: string; individual_id: string; label: string; start_date: string; end_date: string;
    period_type: string; renewal_date: string | null; status: string; source: string | null; notes: string | null;
  }>(
    `SELECT id, individual_id, label, start_date::text AS start_date, end_date::text AS end_date,
            period_type, renewal_date::text AS renewal_date, status, source, notes
       FROM budget_periods WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  return r
    ? {
        id: r.id, individualId: r.individual_id, label: r.label, startDate: r.start_date, endDate: r.end_date,
        periodType: r.period_type, renewalDate: r.renewal_date, status: r.status, source: r.source, notes: r.notes,
      }
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
  /** Effective employee/internal rate stored for this authorization revision. */
  internalRate: string;
  /** Effective funder/agency rate stored for this authorization revision. */
  agencyRate: string | null;
  /** Present only when the effective employee rate overrides the catalog default. */
  individualRateOverride: string | null;
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
  agency_rate: string | null;
  individual_rate_override: string | null;
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
         a.agency_rate::text AS agency_rate,
         a.individual_rate_override::text AS individual_rate_override,
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
  agencyRate: r.agency_rate,
  individualRateOverride: r.individual_rate_override,
  rateBasis: r.rate_basis,
  revision: r.revision,
  status: r.status,
  supersedesId: r.supersedes_id,
  notes: r.notes,
  source: r.source,
  createdAt: r.created_at,
});

type Queryable = Pick<PgLikePool, "query"> | Pick<PgLikeClient, "query">;

export async function getAuthorization(pool: Queryable, id: string): Promise<AuthorizationRecord | null> {
  if (!isUuid(id)) return null;
  const { rows } = await pool.query<AuthRow>(`${AUTH_SELECT} WHERE a.id = $1`, [id]);
  return rows[0] ? toAuth(rows[0]) : null;
}

export interface AuthorizationInput {
  budgetPeriodId: string;
  programId: string;
  authorizedHours?: string | number | null;
  internalRate?: string | number | null;
  agencyRate?: string | number | null;
  individualRateOverride?: string | number | null;
  authorizedDollars?: string | number | null;
  rateBasis?: string | null;
  notes?: string | null;
  source?: string | null;
}

interface AuthorizationProgramRules {
  programCode: string;
  requiredAuthType: "hours" | "dollars" | "both";
  isActive: boolean;
  allowIndividualRateOverride: boolean;
  defaultAgencyRate: string | null;
  defaultInternalRate: string | null;
}

interface NormalizedAuthorizationValues {
  authorizedHours: string;
  internalRate: string;
  agencyRate: string | null;
  individualRateOverride: string | null;
  authorizedDollars: string | null;
  rateBasis: string;
}

async function authorizationProgramRules(
  pool: Queryable,
  programId: string,
  asOf: string,
): Promise<AuthorizationProgramRules | null> {
  const { rows } = await pool.query<{
    required_auth_type: "hours" | "dollars" | "both";
    code: string;
    is_active: boolean;
    allow_individual_rate_override: boolean;
    agency_rate: string | null;
    internal_rate: string | null;
  }>(
    `SELECT p.code, p.required_auth_type, p.is_active, p.allow_individual_rate_override,
            rate.agency_rate::text AS agency_rate,
            rate.internal_rate::text AS internal_rate
       FROM programs p
       LEFT JOIN LATERAL (
         SELECT prs.agency_rate, prs.internal_rate
           FROM program_rate_schedules prs
          WHERE prs.program_id = p.id
            AND prs.archived_at IS NULL
            AND prs.effective_from <= $2::date
            AND (prs.effective_to IS NULL OR prs.effective_to >= $2::date)
          ORDER BY prs.effective_from DESC, prs.id DESC
          LIMIT 1
       ) rate ON TRUE
      WHERE p.id = $1`,
    [programId, asOf],
  );
  return rows[0]
    ? {
        programCode: rows[0].code,
        requiredAuthType: rows[0].required_auth_type,
        isActive: rows[0].is_active,
        allowIndividualRateOverride: rows[0].allow_individual_rate_override,
        defaultAgencyRate: rows[0].agency_rate,
        defaultInternalRate: rows[0].internal_rate,
      }
    : null;
}

function normalizeAuthorizationValues(
  input: Partial<Pick<
    AuthorizationInput,
    | "authorizedHours"
    | "internalRate"
    | "agencyRate"
    | "individualRateOverride"
    | "authorizedDollars"
    | "rateBasis"
  >>,
  rules: AuthorizationProgramRules,
  before?: AuthorizationRecord,
): Result<NormalizedAuthorizationValues> {
  const requiredAuthType = rules.requiredAuthType;
  const hoursRequired = requiredAuthType === "hours" || requiredAuthType === "both";
  const dollarsRequired = requiredAuthType === "dollars" || requiredAuthType === "both";
  const hoursMissing = input.authorizedHours === undefined || input.authorizedHours === null || String(input.authorizedHours).trim() === "";
  const dollarsMissing = input.authorizedDollars === undefined || input.authorizedDollars === null || String(input.authorizedDollars).trim() === "";

  if (hoursRequired && hoursMissing) return fail("validation", "This program requires authorized hours.");
  if (dollarsRequired && dollarsMissing) {
    return fail("validation", "This program requires an authorized dollar amount.");
  }

  const hours = tryDec(hoursMissing ? "0" : input.authorizedHours);
  const dollars = dollarsMissing ? null : tryDec(input.authorizedDollars);
  if (!hours || hours.lt(0)) return fail("validation", "Enter valid authorized hours.");
  if (!dollarsMissing && (!dollars || dollars.lt(0))) {
    return fail("validation", "Enter a valid authorized dollar amount.");
  }

  // `internal_rate` is the effective employee rate snapshot used by existing
  // planning and utilization SQL. `individual_rate_override` records why that
  // snapshot differs from the catalog default. The legacy `internalRate` input
  // remains accepted as an alias for the explicit employee-rate field.
  const employeeRateProvided = input.individualRateOverride !== undefined || input.internalRate !== undefined;
  const employeeRateInput = input.individualRateOverride !== undefined
    ? input.individualRateOverride
    : input.internalRate;
  const defaultInternal = rules.defaultInternalRate ?? (hoursRequired ? null : "0");
  let internalRate: string;
  let individualRateOverride: string | null;
  if (!employeeRateProvided && before) {
    internalRate = before.internalRate;
    individualRateOverride = before.individualRateOverride;
  } else {
    const raw = employeeRateInput === null || employeeRateInput === undefined
      ? ""
      : String(employeeRateInput).trim();
    const parsed = raw === "" ? (defaultInternal === null ? null : tryDec(defaultInternal)) : tryDec(raw);
    if (!parsed || parsed.lt(0)) {
      return fail(
        "validation",
        hoursRequired
          ? "Configure a valid default employee rate for this program, or enter an allowed individual rate."
          : "Enter a valid employee rate.",
      );
    }
    const isCatalogDefault = defaultInternal !== null && parsed.eq(defaultInternal);
    const isUnchanged = before ? parsed.eq(before.internalRate) : false;
    if (!isCatalogDefault && !isUnchanged && !rules.allowIndividualRateOverride) {
      return fail("validation", "This program does not allow individual employee-rate overrides.");
    }
    internalRate = toMoney(parsed);
    individualRateOverride = isCatalogDefault
      ? null
      : isUnchanged && before
        ? before.individualRateOverride
        : toMoney(parsed);
  }

  const agencyRateProvided = input.agencyRate !== undefined;
  let agencyRate: string | null;
  if (!agencyRateProvided && before) {
    agencyRate = before.agencyRate;
  } else {
    const raw = input.agencyRate === null || input.agencyRate === undefined
      ? ""
      : String(input.agencyRate).trim();
    const parsed = raw === "" ? null : tryDec(raw);
    if (parsed && parsed.lt(0)) return fail("validation", "Enter a valid funder rate.");
    if (raw !== "" && !parsed) return fail("validation", "Enter a valid funder rate.");
    const proposed = parsed ? toMoney(parsed) : rules.defaultAgencyRate === null ? null : toMoney(rules.defaultAgencyRate);
    const isCatalogDefault = proposed === null
      ? rules.defaultAgencyRate === null
      : rules.defaultAgencyRate !== null && decEquals(proposed, rules.defaultAgencyRate);
    const isUnchanged = before
      ? proposed === null
        ? before.agencyRate === null
        : before.agencyRate !== null && decEquals(proposed, before.agencyRate)
      : false;
    if (!isCatalogDefault && !isUnchanged && !rules.allowIndividualRateOverride) {
      return fail("validation", "This program does not allow individual funder-rate overrides.");
    }
    agencyRate = proposed;
  }

  return ok({
    authorizedHours: toHours(hours),
    internalRate,
    agencyRate,
    individualRateOverride,
    authorizedDollars: dollars ? toMoney(dollars) : null,
    rateBasis: input.rateBasis?.trim() || requiredAuthType,
  });
}

function decEquals(left: string, right: string): boolean {
  const a = tryDec(left);
  const b = tryDec(right);
  return Boolean(a && b && a.eq(b));
}

/**
 * Transactional implementation used by workflows that already own a client.
 * The advisory lock serializes the overlap check for one individual+program.
 */
export async function createAuthorizationInTransaction(
  client: PgLikeClient,
  input: AuthorizationInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<AuthorizationRecord>> {
  if (!isUuid(input.budgetPeriodId) || !isUuid(input.programId)) {
    return fail("validation", "Choose a budget period and a program.");
  }

  const period = await getBudgetPeriod(client, input.budgetPeriodId);
  if (!period) return fail("not_found", "That budget period no longer exists.");
  if (period.status !== "active") return fail("conflict", "That budget period is not active.");

  const programRules = await authorizationProgramRules(client, input.programId, period.startDate);
  if (!programRules) return fail("not_found", "That program no longer exists.");
  if (programRules.programCode === "CLASSES") {
    return fail("conflict", "Class allowances must be created from the Classes workspace.");
  }
  if (!programRules.isActive) {
    return fail("conflict", "That program is archived and cannot receive a new authorization.");
  }
  const normalized = normalizeAuthorizationValues(input, programRules);
  if (!normalized.ok) return normalized;

  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`budget_authorization:${period.individualId}:${input.programId}`],
  );

  const existing = await client.query(
    `SELECT id FROM budget_authorizations
      WHERE budget_period_id = $1 AND program_id = $2
        AND status = 'active' AND archived_at IS NULL`,
    [input.budgetPeriodId, input.programId],
  );
  if (existing.rows[0]) {
    return fail("conflict", "This program already has an active authorization in this period. Revise it instead.");
  }
  const overlap = await client.query(
    `SELECT 1
       FROM budget_authorizations a
       JOIN budget_periods existing_period ON existing_period.id = a.budget_period_id
      WHERE a.individual_id = $1
        AND a.program_id = $2
        AND a.status = 'active'
        AND a.archived_at IS NULL
        AND existing_period.status = 'active'
        AND existing_period.archived_at IS NULL
        AND existing_period.id <> $3
        AND daterange(existing_period.start_date, existing_period.end_date, '[]')
            && daterange($4::date, $5::date, '[]')
      LIMIT 1`,
    [period.individualId, input.programId, input.budgetPeriodId, period.startDate, period.endDate],
  );
  if (overlap.rows[0]) {
    return fail("conflict", "This individual already has an active budget for that program covering part of this period.");
  }

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO budget_authorizations
       (budget_period_id, individual_id, program_id, authorized_hours, internal_rate,
        agency_rate, individual_rate_override, rate_override, authorized_dollars,
        rate_basis, notes, source, created_by_user_id, revision, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, 'active') RETURNING id`,
    [
      input.budgetPeriodId,
      period.individualId,
      input.programId,
      normalized.data.authorizedHours,
      normalized.data.internalRate,
      normalized.data.agencyRate,
      normalized.data.individualRateOverride,
      normalized.data.individualRateOverride !== null,
      normalized.data.authorizedDollars,
      normalized.data.rateBasis,
      input.notes?.trim() || null,
      input.source ?? "manual",
      actorId,
    ],
  );
  const record = await getAuthorization(client, rows[0]!.id);
  await recordChange(client, {
    actorId,
    action: "authorization_created",
    entityType: "authorization",
    entityId: rows[0]!.id,
    next: record,
    reason,
  });
  return ok(record!);
}

export async function createAuthorization(
  pool: PgLikePool,
  input: AuthorizationInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<AuthorizationRecord>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await createAuthorizationInTransaction(client, input, actorId, reason);
    if (!result.ok) {
      await client.query("ROLLBACK");
      return result;
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Supersede the current authorization with a new revision. History preserved. */
export async function reviseAuthorization(
  pool: PgLikePool,
  id: string,
  input: Partial<Pick<
    AuthorizationInput,
    | "authorizedHours"
    | "internalRate"
    | "agencyRate"
    | "individualRateOverride"
    | "authorizedDollars"
    | "rateBasis"
    | "notes"
  >>,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<AuthorizationRecord>> {
  if (!isUuid(id)) return fail("not_found", "That authorization no longer exists.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT id FROM budget_authorizations WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!locked.rows[0]) {
      await client.query("ROLLBACK");
      return fail("not_found", "That authorization no longer exists.");
    }
    const before = await getAuthorization(client, id);
    if (!before) {
      await client.query("ROLLBACK");
      return fail("not_found", "That authorization no longer exists.");
    }
    if (before.status !== "active") {
      await client.query("ROLLBACK");
      return fail("immutable", "Only the active revision can be revised.");
    }
    const period = await getBudgetPeriod(client, before.budgetPeriodId);
    if (!period) {
      await client.query("ROLLBACK");
      return fail("not_found", "That budget period no longer exists.");
    }
    const programRules = await authorizationProgramRules(client, before.programId, period.startDate);
    if (!programRules) {
      await client.query("ROLLBACK");
      return fail("not_found", "That program no longer exists.");
    }
    if (programRules.programCode === "CLASSES") {
      await client.query("ROLLBACK");
      return fail("conflict", "Class allowances must be revised from the Classes workspace.");
    }
    if (!programRules.isActive) {
      await client.query("ROLLBACK");
      return fail("conflict", "That program is archived and its authorization cannot be revised.");
    }
    const normalized = normalizeAuthorizationValues(
      {
        authorizedHours: input.authorizedHours !== undefined ? input.authorizedHours : before.authorizedHours,
        authorizedDollars: input.authorizedDollars !== undefined ? input.authorizedDollars : before.authorizedDollars,
        rateBasis: input.rateBasis !== undefined ? input.rateBasis : before.rateBasis,
        ...(input.internalRate !== undefined ? { internalRate: input.internalRate } : {}),
        ...(input.individualRateOverride !== undefined ? { individualRateOverride: input.individualRateOverride } : {}),
        ...(input.agencyRate !== undefined ? { agencyRate: input.agencyRate } : {}),
      },
      programRules,
      before,
    );
    if (!normalized.ok) {
      await client.query("ROLLBACK");
      return normalized;
    }
    await client.query(
      `UPDATE budget_authorizations SET status = 'superseded', updated_at = now() WHERE id = $1`,
      [id],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO budget_authorizations
         (budget_period_id, individual_id, program_id, authorized_hours, internal_rate,
          agency_rate, individual_rate_override, rate_override, authorized_dollars,
          rate_basis, notes, source, created_by_user_id, revision, status, supersedes_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'active', $15) RETURNING id`,
      [
        before.budgetPeriodId,
        before.individualId,
        before.programId,
        normalized.data.authorizedHours,
        normalized.data.internalRate,
        normalized.data.agencyRate,
        normalized.data.individualRateOverride,
        normalized.data.individualRateOverride !== null,
        normalized.data.authorizedDollars,
        normalized.data.rateBasis,
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
    const revised = await getAuthorization(client, rows[0]!.id);
    await client.query("COMMIT");
    return ok(revised!);
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
  if (!isUuid(id)) return fail("not_found", "That authorization no longer exists.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT id FROM budget_authorizations WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!locked.rows[0]) {
      await client.query("ROLLBACK");
      return fail("not_found", "That authorization no longer exists.");
    }
    const before = await getAuthorization(client, id);
    if (!before) {
      await client.query("ROLLBACK");
      return fail("not_found", "That authorization no longer exists.");
    }
    if (before.status !== "active") {
      await client.query("ROLLBACK");
      return fail("immutable", "Only the active authorization can be cancelled.");
    }
    if (before.programCode === "CLASSES") {
      await client.query("ROLLBACK");
      return fail("conflict", "Class allowances must be closed from the Classes workspace.");
    }
    await client.query(
      `UPDATE budget_authorizations SET status = 'cancelled', archived_at = now(), updated_at = now() WHERE id = $1`,
      [id],
    );
    await recordChange(client, {
      actorId,
      action: "authorization_cancelled",
      entityType: "authorization",
      entityId: id,
      previous: { status: before.status },
      next: { status: "cancelled" },
      reason,
    });
    const cancelled = await getAuthorization(client, id);
    await client.query("COMMIT");
    return ok(cancelled!);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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
      period_type: string; renewal_date: string | null; status: string; source: string | null; notes: string | null;
    }>(
      `SELECT id, individual_id, label, start_date::text AS start_date, end_date::text AS end_date,
              period_type, renewal_date::text AS renewal_date, status, source, notes FROM budget_periods
       WHERE individual_id = $1 ORDER BY start_date DESC`,
      [individualId],
    ),
    pool.query<AuthRow>(`${AUTH_SELECT} WHERE a.individual_id = $1 ORDER BY a.created_at DESC`, [individualId]),
  ]);
  return {
    periods: periodsRes.rows.map((r) => ({
      id: r.id, individualId: r.individual_id, label: r.label, startDate: r.start_date,
      endDate: r.end_date, periodType: r.period_type, renewalDate: r.renewal_date,
      status: r.status, source: r.source, notes: r.notes,
    })),
    authorizations: authRes.rows.map(toAuth),
  };
}
