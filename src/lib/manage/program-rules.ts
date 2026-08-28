import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { ok, fail, type Result } from "./errors";
import { toMoney } from "@/lib/money";

/**
 * Per-program rule configuration: the flags that decide whether a program is
 * one-to-one or group, how the agency-vs-employee split behaves, whether an
 * individual rate override is allowed, and what an authorization must specify.
 * Everything here is admin-editable and every change is audited. Follows the
 * style of `programs.ts` — additive, data-preserving, never destructive.
 */

const isUuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
const AUTH_TYPES = new Set(["hours", "dollars", "both"]);
const PAYMENT_RECIPIENTS = new Set(["agency", "employee", "external", "not_applicable"]);
const CONSUMPTION_SOURCES = new Set(["payroll", "invoice", "manual", "mixed"]);
const RATE_SCOPES = new Set(["per_individual", "per_group", "flat"]);
const RENEWAL_POLICIES = new Set(["individual", "calendar", "rolling", "custom"]);

export interface ProgramRulesRow {
  id: string;
  code: string;
  name: string;
  oneToOneRequired: boolean;
  groupsAllowed: boolean;
  maxGroupSize: number | null;
  allowMultipleEmployees: boolean;
  allowMultipleIndividuals: boolean;
  allowIndividualRateOverride: boolean;
  selfHireConverts: boolean;
  agencyAdditionalRate: string | null;
  requiredAuthType: string;
  serviceCategory: string;
  paymentRecipient: string;
  consumptionSource: string;
  rateScope: string;
  renewalPolicy: string;
}

/** Only the fields actually supplied are changed; absent fields are left as-is. */
export interface ProgramRulesInput {
  oneToOneRequired?: boolean;
  groupsAllowed?: boolean;
  maxGroupSize?: number | null;
  allowMultipleEmployees?: boolean;
  allowMultipleIndividuals?: boolean;
  allowIndividualRateOverride?: boolean;
  selfHireConverts?: boolean;
  agencyAdditionalRate?: string | null;
  requiredAuthType?: string;
  serviceCategory?: string;
  paymentRecipient?: string;
  consumptionSource?: string;
  rateScope?: string;
  renewalPolicy?: string;
}

interface RulesDbRow {
  id: string;
  code: string;
  name: string;
  one_to_one_required: boolean;
  groups_allowed: boolean;
  max_group_size: number | null;
  allow_multiple_employees: boolean;
  allow_multiple_individuals: boolean;
  allow_individual_rate_override: boolean;
  self_hire_converts: boolean;
  agency_additional_rate: string | null;
  required_auth_type: string;
  service_category: string;
  payment_recipient: string;
  consumption_source: string;
  rate_scope: string;
  renewal_policy: string;
}

const RULE_COLS = `id, code, name,
  one_to_one_required, groups_allowed, max_group_size,
  allow_multiple_employees, allow_multiple_individuals,
  allow_individual_rate_override, self_hire_converts,
  agency_additional_rate::text AS agency_additional_rate, required_auth_type,
  service_category, payment_recipient, consumption_source, rate_scope, renewal_policy`;

function toRules(r: RulesDbRow): ProgramRulesRow {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    oneToOneRequired: r.one_to_one_required,
    groupsAllowed: r.groups_allowed,
    maxGroupSize: r.max_group_size === null ? null : Number(r.max_group_size),
    allowMultipleEmployees: r.allow_multiple_employees,
    allowMultipleIndividuals: r.allow_multiple_individuals,
    allowIndividualRateOverride: r.allow_individual_rate_override,
    selfHireConverts: r.self_hire_converts,
    agencyAdditionalRate: r.agency_additional_rate,
    requiredAuthType: r.required_auth_type,
    serviceCategory: r.service_category,
    paymentRecipient: r.payment_recipient,
    consumptionSource: r.consumption_source,
    rateScope: r.rate_scope,
    renewalPolicy: r.renewal_policy,
  };
}

/** Every program with its current rule values, for the settings editor. */
export async function listProgramRules(pool: PgLikePool): Promise<ProgramRulesRow[]> {
  const { rows } = await pool.query<RulesDbRow>(`SELECT ${RULE_COLS} FROM programs ORDER BY code`);
  return rows.map(toRules);
}

/** A single program's rule values, or null if it does not exist. */
export async function getProgramRules(pool: PgLikePool, id: string): Promise<ProgramRulesRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await pool.query<RulesDbRow>(`SELECT ${RULE_COLS} FROM programs WHERE id = $1`, [id]);
  return rows[0] ? toRules(rows[0]) : null;
}

/**
 * Update the supplied rule columns on a program. Booleans, the (nullable) max
 * group size and agency additional rate, and the required auth type are each
 * only written when present in `rules`, so a partial patch never clears a field
 * the caller did not mean to touch.
 */
export async function updateProgramRules(
  pool: PgLikePool,
  programId: string,
  rules: ProgramRulesInput,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  if (!isUuid(programId)) return fail("validation", "Invalid program.");

  const before = await getProgramRules(pool, programId);
  if (!before) return fail("not_found", "That program no longer exists.");

  // Validate the two free-form numeric fields and the auth type before writing.
  if (rules.maxGroupSize !== undefined && rules.maxGroupSize !== null) {
    if (!Number.isInteger(rules.maxGroupSize) || rules.maxGroupSize < 1) {
      return fail("validation", "Max group size must be a whole number of at least 1, or blank.");
    }
  }
  let agencyAdditional: string | null | undefined = rules.agencyAdditionalRate;
  if (rules.agencyAdditionalRate !== undefined && rules.agencyAdditionalRate !== null) {
    const num = Number(rules.agencyAdditionalRate);
    if (!Number.isFinite(num) || num < 0) {
      return fail("validation", "Enter a valid agency additional rate, or leave it blank.");
    }
    agencyAdditional = toMoney(rules.agencyAdditionalRate);
  }
  if (rules.requiredAuthType !== undefined && !AUTH_TYPES.has(rules.requiredAuthType)) {
    return fail("validation", "Required authorization type must be hours, dollars or both.");
  }
  if (rules.serviceCategory !== undefined && !rules.serviceCategory.trim()) {
    return fail("validation", "Choose a service category.");
  }
  if (rules.paymentRecipient !== undefined && !PAYMENT_RECIPIENTS.has(rules.paymentRecipient)) {
    return fail("validation", "Choose who receives payment for this program.");
  }
  if (rules.consumptionSource !== undefined && !CONSUMPTION_SOURCES.has(rules.consumptionSource)) {
    return fail("validation", "Choose how this program consumes its budget.");
  }
  if (rules.rateScope !== undefined && !RATE_SCOPES.has(rules.rateScope)) {
    return fail("validation", "Choose whether this program's rate applies per individual, per group, or as a flat amount.");
  }
  if (rules.renewalPolicy !== undefined && !RENEWAL_POLICIES.has(rules.renewalPolicy)) {
    return fail("validation", "Choose the program's renewal policy.");
  }

  // Build the SET clause from only the provided fields; $1 is the program id.
  const values: unknown[] = [programId];
  const sets: string[] = [];
  const set = (col: string, value: unknown) => {
    values.push(value);
    sets.push(`${col} = $${values.length}`);
  };
  if (rules.oneToOneRequired !== undefined) set("one_to_one_required", rules.oneToOneRequired);
  if (rules.groupsAllowed !== undefined) set("groups_allowed", rules.groupsAllowed);
  if (rules.maxGroupSize !== undefined) set("max_group_size", rules.maxGroupSize);
  if (rules.allowMultipleEmployees !== undefined) set("allow_multiple_employees", rules.allowMultipleEmployees);
  if (rules.allowMultipleIndividuals !== undefined) set("allow_multiple_individuals", rules.allowMultipleIndividuals);
  if (rules.allowIndividualRateOverride !== undefined) set("allow_individual_rate_override", rules.allowIndividualRateOverride);
  if (rules.selfHireConverts !== undefined) set("self_hire_converts", rules.selfHireConverts);
  if (agencyAdditional !== undefined) set("agency_additional_rate", agencyAdditional);
  if (rules.requiredAuthType !== undefined) set("required_auth_type", rules.requiredAuthType);
  if (rules.serviceCategory !== undefined) set("service_category", rules.serviceCategory.trim());
  if (rules.paymentRecipient !== undefined) set("payment_recipient", rules.paymentRecipient);
  if (rules.consumptionSource !== undefined) set("consumption_source", rules.consumptionSource);
  if (rules.rateScope !== undefined) set("rate_scope", rules.rateScope);
  if (rules.renewalPolicy !== undefined) set("renewal_policy", rules.renewalPolicy);

  if (sets.length === 0) return fail("validation", "No rule changes were provided.");

  await pool.query(
    `UPDATE programs SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
    values,
  );

  const after = await getProgramRules(pool, programId);
  await recordChange(pool, {
    actorId,
    action: "program_rules_updated",
    entityType: "program",
    entityId: programId,
    previous: before,
    next: after ?? undefined,
    reason,
  });
  return ok({ id: programId });
}
