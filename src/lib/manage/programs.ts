import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";
import { toMoney } from "@/lib/money";

export interface ProgramRecord {
  id: string;
  code: string;
  name: string;
  isGroupCapable: boolean;
  isActive: boolean;
  notes: string | null;
  archivedAt: string | null;
}

interface Row {
  id: string;
  code: string;
  name: string;
  is_group_capable: boolean;
  is_active: boolean;
  notes: string | null;
  archived_at: string | null;
}

const COLS = `id, code, name, is_group_capable, is_active, notes, archived_at::text AS archived_at`;
const toRecord = (r: Row): ProgramRecord => ({
  id: r.id,
  code: r.code,
  name: r.name,
  isGroupCapable: r.is_group_capable,
  isActive: r.is_active,
  notes: r.notes,
  archivedAt: r.archived_at,
});

export async function getProgram(pool: PgLikePool, id: string): Promise<ProgramRecord | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await pool.query<Row>(`SELECT ${COLS} FROM programs WHERE id = $1`, [id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export interface ProgramInput {
  code: string;
  name: string;
  isGroupCapable?: boolean;
  notes?: string | null;
}

export interface ProgramSetupInput extends Omit<ProgramInput, "code"> {
  code?: string;
  requiredAuthType?: string;
  serviceCategory?: string;
  paymentRecipient?: string;
  consumptionSource?: string;
  rateScope?: string;
  renewalPolicy?: string;
  groupsAllowed?: boolean;
  oneToOneRequired?: boolean;
  maxGroupSize?: number | null;
  allowMultipleEmployees?: boolean;
  allowMultipleIndividuals?: boolean;
  allowIndividualRateOverride?: boolean;
  selfHireConverts?: boolean;
  agencyAdditionalRate?: string | null;
  effectiveFrom?: string | null;
  internalRate?: string | null;
  agencyRate?: string | null;
}

const AUTH_TYPES = new Set(["hours", "dollars", "both"]);
const SERVICE_CATEGORIES = new Set(["direct_service", "self_hire", "group_service", "classes", "other"]);
const PAYMENT_RECIPIENTS = new Set(["agency", "employee", "external", "not_applicable"]);
const CONSUMPTION_SOURCES = new Set(["payroll", "invoice", "manual", "mixed"]);
const RATE_SCOPES = new Set(["per_individual", "per_group", "flat"]);
const RENEWAL_POLICIES = new Set(["individual", "calendar", "rolling", "custom"]);

function normalizedProgramCode(value: string | undefined, fallbackName: string): string {
  return (value?.trim() || fallbackName)
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function uniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

/**
 * Create the program, its common operating rules, and an optional starting
 * rate as one unit. The guided settings form uses this path so a later step
 * can never leave a half-configured catalog entry behind.
 */
export async function createProgramSetup(
  pool: PgLikePool,
  input: ProgramSetupInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<ProgramRecord>> {
  const name = input.name?.trim();
  if (!name) return fail("validation", "Enter a program name.");
  const code = normalizedProgramCode(input.code, name);
  if (!code) return fail("validation", "Enter a program name or short code.");

  const requiredAuthType = input.requiredAuthType ?? "hours";
  const serviceCategory = input.serviceCategory ?? "direct_service";
  const paymentRecipient = input.paymentRecipient ?? "agency";
  const consumptionSource = input.consumptionSource ?? "payroll";
  const groupsAllowed = input.groupsAllowed ?? input.isGroupCapable ?? false;
  const rateScope = input.rateScope ?? (groupsAllowed ? "per_group" : "per_individual");
  const renewalPolicy = input.renewalPolicy ?? "individual";

  if (!AUTH_TYPES.has(requiredAuthType)) return fail("validation", "Choose whether this budget uses hours, dollars, or both.");
  if (!SERVICE_CATEGORIES.has(serviceCategory)) return fail("validation", "Choose a valid service type.");
  if (!PAYMENT_RECIPIENTS.has(paymentRecipient)) return fail("validation", "Choose who receives payment for this program.");
  if (!CONSUMPTION_SOURCES.has(consumptionSource)) return fail("validation", "Choose how usage enters the system.");
  if (!RATE_SCOPES.has(rateScope)) return fail("validation", "Choose how the rate applies.");
  if (!RENEWAL_POLICIES.has(renewalPolicy)) return fail("validation", "Choose how the program renews.");
  if (input.maxGroupSize !== undefined && input.maxGroupSize !== null
      && (!Number.isInteger(input.maxGroupSize) || input.maxGroupSize < 1)) {
    return fail("validation", "Maximum group size must be a whole number of at least 1, or blank.");
  }

  const hasInternalRate = typeof input.internalRate === "string" && input.internalRate.trim() !== "";
  const hasAgencyRate = typeof input.agencyRate === "string" && input.agencyRate.trim() !== "";
  const hasStartingRate = hasInternalRate || hasAgencyRate;
  if (hasStartingRate && !hasInternalRate) {
    return fail("validation", "Enter the employee base rate when adding a starting rate.");
  }
  if (hasStartingRate && !/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom ?? "")) {
    return fail("validation", "Choose the date when the starting rate begins.");
  }
  if (hasInternalRate && (!Number.isFinite(Number(input.internalRate)) || Number(input.internalRate) < 0)) {
    return fail("validation", "Enter a valid employee base rate.");
  }
  if (hasAgencyRate && (!Number.isFinite(Number(input.agencyRate)) || Number(input.agencyRate) < 0)) {
    return fail("validation", "Enter a valid funder rate.");
  }
  if (input.agencyAdditionalRate != null && input.agencyAdditionalRate.trim() !== ""
      && (!Number.isFinite(Number(input.agencyAdditionalRate)) || Number(input.agencyAdditionalRate) < 0)) {
    return fail("validation", "Enter a valid agency spread rate, or leave it blank.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const duplicate = await client.query(`SELECT id FROM programs WHERE code = $1`, [code]);
    if (duplicate.rows[0]) {
      await client.query("ROLLBACK");
      return fail("conflict", "A program with that short code already exists.");
    }

    const { rows } = await client.query<Row>(
      `INSERT INTO programs
       (code, name, is_group_capable, notes, one_to_one_required, groups_allowed,
        max_group_size, allow_multiple_employees, allow_multiple_individuals,
        allow_individual_rate_override, self_hire_converts, agency_additional_rate,
        required_auth_type, service_category, payment_recipient, consumption_source,
        rate_scope, renewal_policy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, $17, $18)
       RETURNING ${COLS}`,
      [
        code,
        name,
        groupsAllowed,
        input.notes?.trim() || null,
        input.oneToOneRequired ?? !groupsAllowed,
        groupsAllowed,
        groupsAllowed ? input.maxGroupSize ?? null : null,
        input.allowMultipleEmployees ?? false,
        input.allowMultipleIndividuals ?? groupsAllowed,
        input.allowIndividualRateOverride ?? true,
        input.selfHireConverts ?? false,
        input.agencyAdditionalRate?.trim() ? toMoney(input.agencyAdditionalRate) : null,
        requiredAuthType,
        serviceCategory,
        paymentRecipient,
        consumptionSource,
        rateScope,
        renewalPolicy,
      ],
    );
    const record = toRecord(rows[0]!);

    if (hasStartingRate) {
      await client.query(
        `INSERT INTO program_rate_schedules
         (program_id, effective_from, agency_rate, internal_rate, notes, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          record.id,
          input.effectiveFrom,
          hasAgencyRate ? toMoney(input.agencyRate!) : null,
          toMoney(input.internalRate!),
          "Starting rate from guided program setup.",
          actorId,
        ],
      );
    }

    await recordChange(client, {
      actorId,
      action: "program_created",
      entityType: "program",
      entityId: record.id,
      next: {
        ...record,
        requiredAuthType,
        serviceCategory,
        paymentRecipient,
        consumptionSource,
        rateScope,
        renewalPolicy,
        startingRate: hasStartingRate
          ? { effectiveFrom: input.effectiveFrom, internalRate: toMoney(input.internalRate!), agencyRate: hasAgencyRate ? toMoney(input.agencyRate!) : null }
          : null,
      },
      reason,
    });
    await client.query("COMMIT");
    return ok(record);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (uniqueViolation(error)) return fail("conflict", "A program with that short code already exists.");
    throw error;
  } finally {
    client.release();
  }
}

export async function createProgram(
  pool: PgLikePool,
  input: ProgramInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<ProgramRecord>> {
  const code = input.code?.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const name = input.name?.trim();
  if (!code) return fail("validation", "A short program code is required.");
  if (!name) return fail("validation", "A program name is required.");
  const dup = await pool.query(`SELECT id FROM programs WHERE code = $1`, [code]);
  if (dup.rows[0]) return fail("conflict", "A program with that code already exists.");

  const { rows } = await pool.query<Row>(
    `INSERT INTO programs (code, name, is_group_capable, notes)
     VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
    [code, name, input.isGroupCapable ?? false, input.notes?.trim() || null],
  );
  const record = toRecord(rows[0]!);
  await recordChange(pool, {
    actorId,
    action: "program_created",
    entityType: "program",
    entityId: record.id,
    next: record,
    reason,
  });
  return ok(record);
}

export async function updateProgram(
  pool: PgLikePool,
  id: string,
  input: Partial<ProgramInput> & { isActive?: boolean },
  actorId: string | null,
  reason?: string | null,
): Promise<Result<ProgramRecord>> {
  const before = await getProgram(pool, id);
  if (!before) return fail("not_found", "That program no longer exists.");
  const { rows } = await pool.query<Row>(
    `UPDATE programs SET
       name = COALESCE($2, name),
       is_group_capable = COALESCE($3, is_group_capable),
       is_active = COALESCE($4, is_active),
       notes = $5,
       archived_at = CASE WHEN $4 IS FALSE THEN now() WHEN $4 IS TRUE THEN NULL ELSE archived_at END,
       updated_at = now()
     WHERE id = $1 RETURNING ${COLS}`,
    [
      id,
      input.name?.trim() || null,
      input.isGroupCapable ?? null,
      input.isActive ?? null,
      input.notes === undefined ? before.notes : input.notes?.trim() || null,
    ],
  );
  const after = toRecord(rows[0]!);
  await recordChange(pool, {
    actorId,
    action: "program_updated",
    entityType: "program",
    entityId: id,
    previous: before,
    next: after,
    reason,
  });
  return ok(after);
}

/**
 * Add a new effective-dated rate. Never edits an existing rate row — the rate
 * schedule is history, and the latest effective_from on or before a date wins.
 */
export async function addProgramRate(
  pool: PgLikePool,
  programId: string,
  input: { effectiveFrom: string; internalRate: string; agencyRate?: string | null; notes?: string | null },
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  const program = await getProgram(pool, programId);
  if (!program) return fail("not_found", "That program no longer exists.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) {
    return fail("validation", "Give an effective-from date (YYYY-MM-DD).");
  }
  const internal = Number(input.internalRate);
  if (!Number.isFinite(internal) || internal < 0) {
    return fail("validation", "Enter a valid internal rate.");
  }
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO program_rate_schedules
     (program_id, effective_from, agency_rate, internal_rate, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (program_id, effective_from) DO NOTHING
     RETURNING id`,
    [
      programId,
      input.effectiveFrom,
      input.agencyRate ? toMoney(input.agencyRate) : null,
      toMoney(input.internalRate),
      input.notes?.trim() || null,
      actorId,
    ],
  );
  if (!rows[0]) return fail("conflict", "A rate already starts on that date. Choose another effective date.");
  await recordChange(pool, {
    actorId,
    action: "program_rate_added",
    entityType: "program",
    entityId: programId,
    next: {
      effectiveFrom: input.effectiveFrom,
      internalRate: toMoney(input.internalRate),
      agencyRate: input.agencyRate ? toMoney(input.agencyRate) : null,
    },
    reason,
  });
  return ok({ id: rows[0]!.id });
}
