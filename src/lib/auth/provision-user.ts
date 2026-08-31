import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "@/lib/manage/audit";
import { setAgencyUserAccessQuery } from "@/lib/manage/agencies";
import {
  setEmployeePortalAssignmentQuery,
  setGlobalPortalRoleAssignmentQuery,
  setIndividualPortalAssignmentQuery,
} from "@/lib/manage/portal-identities";
import { fail, ok, type Result, type ResultCode } from "@/lib/manage/errors";
import { hashPassword } from "./crypto";
import {
  getAccountPreset,
  type AccountPresetId,
} from "./account-presets";
import type { IndividualRelationship } from "./portal-access";
import {
  createUserWithAccessQuery,
  MIN_PASSWORD_LENGTH,
  normalizeEmail,
  userAccessConfigFromInput,
} from "./users";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const INDIVIDUAL_RELATIONSHIPS: IndividualRelationship[] = [
  "self",
  "parent",
  "guardian",
  "representative",
];

export interface ProvisionUserInput {
  preset: string;
  email: string;
  displayName: string;
  password: string;
  individualId?: string;
  relationship?: string;
  employeeId?: string;
  agencyId?: string;
  capabilityGrants?: string[];
  capabilityDenials?: string[];
  reason?: string | null;
}

export interface ProvisionedUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  isActive: boolean;
  preset: AccountPresetId;
}

class ProvisioningAbort extends Error {
  constructor(
    readonly code: ResultCode,
    message: string,
  ) {
    super(message);
  }
}

function optionalStringArray(
  value: unknown,
  label: string,
): Result<string[] | undefined> {
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return fail("validation", `${label} must be a list of permission names.`);
  }
  return ok([...new Set(value.map((item) => item.trim()).filter(Boolean))]);
}

function abortOnFailure<T>(result: Result<T>): T {
  if (!result.ok) throw new ProvisioningAbort(result.code, result.message);
  return result.data;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

/**
 * Create a login, its internal access, and its portal identity as one unit.
 * A portal binding that cannot be completed aborts the whole transaction, so
 * an administrator can never be left with a valid login that opens an empty or
 * incorrectly scoped portal.
 */
export async function provisionUser(
  pool: PgLikePool,
  input: ProvisionUserInput,
  actorId: string,
): Promise<Result<ProvisionedUser>> {
  const preset = getAccountPreset(input.preset);
  if (!preset) return fail("validation", "Choose a valid account role.");

  const email = normalizeEmail(input.email ?? "");
  if (!EMAIL.test(email)) return fail("validation", "Enter a valid email address.");
  if (typeof input.password !== "string" || input.password.length < MIN_PASSWORD_LENGTH) {
    return fail("validation", `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const grantsResult = optionalStringArray(
    (input as { capabilityGrants?: unknown }).capabilityGrants,
    "Capability grants",
  );
  if (!grantsResult.ok) return grantsResult;
  const denialsResult = optionalStringArray(
    (input as { capabilityDenials?: unknown }).capabilityDenials,
    "Capability denials",
  );
  if (!denialsResult.ok) return denialsResult;
  const requestedGrants = grantsResult.data;
  const capabilityDenials = denialsResult.data ?? [];

  let individualId: string | null = null;
  let relationship: IndividualRelationship | null = null;
  let employeeId: string | null = null;
  let agencyId: string | null = null;

  if (preset.binding.kind === "individual") {
    individualId = input.individualId?.trim() ?? "";
    if (!UUID.test(individualId)) return fail("validation", "Choose an individual for this portal.");
    if (!INDIVIDUAL_RELATIONSHIPS.includes(input.relationship as IndividualRelationship)) {
      return fail("validation", "Choose how this account is related to the individual.");
    }
    relationship = input.relationship as IndividualRelationship;
  } else if (preset.binding.kind === "employee") {
    employeeId = input.employeeId?.trim() ?? "";
    if (!UUID.test(employeeId)) return fail("validation", "Choose an employee for this portal.");
  } else if (preset.binding.kind === "agency") {
    agencyId = input.agencyId?.trim() ?? "";
    if (!UUID.test(agencyId)) return fail("validation", "Choose an agency for this portal.");
  } else if (requestedGrants !== undefined || capabilityDenials.length > 0) {
    return fail("validation", "Visibility overrides apply only to portal accounts.");
  }

  const passwordHash = await hashPassword(input.password);
  const access = preset.access ?? userAccessConfigFromInput({}, preset.role);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = await createUserWithAccessQuery(client, {
      email,
      displayName: input.displayName?.trim() || email,
      passwordHash,
      role: preset.role,
    }, access, actorId);
    if (!created.ok) {
      throw new ProvisioningAbort("conflict", "An account with that email address already exists.");
    }

    const userId = created.user.id;
    const reason = input.reason?.trim() || null;
    switch (preset.binding.kind) {
      case "none":
        break;
      case "owner":
        abortOnFailure(await setGlobalPortalRoleAssignmentQuery(
          client,
          { userId, role: "owner", isActive: true },
          actorId,
          reason,
        ));
        break;
      case "individual": {
        const portalRole = relationship === "self" ? "individual" : "parent";
        abortOnFailure(await setGlobalPortalRoleAssignmentQuery(
          client,
          { userId, role: portalRole, isActive: true },
          actorId,
          reason,
        ));
        const capabilityGrants = requestedGrants ?? preset.binding.defaultCapabilityGrants
          .filter((capability) => !capabilityDenials.includes(capability));
        abortOnFailure(await setIndividualPortalAssignmentQuery(
          client,
          {
            userId,
            individualId: individualId!,
            relationship: relationship!,
            isActive: true,
            capabilityGrants,
            capabilityDenials,
          },
          actorId,
          reason,
        ));
        break;
      }
      case "employee":
        abortOnFailure(await setGlobalPortalRoleAssignmentQuery(
          client,
          { userId, role: "employee", isActive: true },
          actorId,
          reason,
        ));
        abortOnFailure(await setEmployeePortalAssignmentQuery(
          client,
          {
            userId,
            employeeId: employeeId!,
            isActive: true,
            capabilityGrants: requestedGrants ?? [],
            capabilityDenials,
          },
          actorId,
          reason,
        ));
        break;
      case "agency":
        abortOnFailure(await setAgencyUserAccessQuery(
          client,
          agencyId!,
          {
            userId,
            role: preset.binding.role,
            isActive: true,
            capabilityGrants: requestedGrants ?? [],
            capabilityDenials,
          },
          actorId,
          reason,
        ));
        break;
    }

    await recordChange(client, {
      actorId,
      action: "user_provisioned",
      entityType: "user",
      entityId: userId,
      next: { preset: preset.id },
      reason,
    });
    await client.query("COMMIT");
    return ok({
      id: userId,
      email: created.user.email,
      displayName: created.user.displayName,
      role: created.user.role,
      isActive: created.user.isActive,
      preset: preset.id,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof ProvisioningAbort) return fail(error.code, error.message);
    if (isUniqueViolation(error)) return fail("conflict", "An account with that email address already exists.");
    throw error;
  } finally {
    client.release();
  }
}
