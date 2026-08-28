import { resolveAccessScope, type AccessScope } from "@/lib/auth/access";
import { apiUser, type AuthenticatedUser } from "@/lib/auth/session";
import { getPool } from "@/lib/db";
import type { PgLikePool } from "@/lib/import/commit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SettlementOperator {
  user: AuthenticatedUser;
  scope: AccessScope;
  pool: PgLikePool;
}

export function canOperateSettlementPerson(
  scope: AccessScope,
  person: { employeeId: string | null; individualId: string | null },
): boolean {
  if (scope.full) return true;
  if (person.employeeId) {
    return scope.allEmployees || scope.grantedEmployeeIds.includes(person.employeeId);
  }
  if (person.individualId) {
    return scope.allIndividuals || scope.grantedIndividualIds.includes(person.individualId);
  }
  return false;
}

/** A viewer may operate the money ledger only when an admin explicitly grants it. */
export async function getSettlementOperator(): Promise<SettlementOperator | null> {
  const user = await apiUser("viewer");
  if (!user) return null;
  const pool = getPool();
  const scope = await resolveAccessScope(pool, user);
  return scope.canManageSettlements ? { user, scope, pool } : null;
}

export async function canOperateSettlementObligations(
  pool: PgLikePool,
  scope: AccessScope,
  obligationIds: readonly string[],
): Promise<boolean> {
  const ids = [...new Set(obligationIds)];
  if (ids.length === 0 || ids.some((id) => !UUID.test(id))) return false;
  const { rows } = await pool.query<{ id: string; employee_id: string | null; individual_id: string | null }>(
    `SELECT id, employee_id, individual_id
       FROM settlement_obligations
      WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return rows.length === ids.length && rows.every((row) => canOperateSettlementPerson(scope, {
    employeeId: row.employee_id,
    individualId: row.individual_id,
  }));
}

export async function canOperateSettlementEvent(
  pool: PgLikePool,
  scope: AccessScope,
  eventId: string,
): Promise<boolean> {
  if (!UUID.test(eventId)) return false;
  const { rows } = await pool.query<{ employee_id: string | null; individual_id: string | null }>(
    `SELECT employee_id, individual_id FROM settlement_events WHERE id = $1`,
    [eventId],
  );
  const row = rows[0];
  return Boolean(row && canOperateSettlementPerson(scope, {
    employeeId: row.employee_id,
    individualId: row.individual_id,
  }));
}
