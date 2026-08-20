import type { PgLikePool } from "@/lib/import/commit";

/**
 * PER-USER ACCESS SCOPE
 * =====================
 *
 * Who is allowed to see which individuals, employees and transactions. An admin
 * can hand out logins that are limited to part of the system:
 *
 *   - `full`   — sees everything (the default for every existing account, and
 *                always true for the `admin` role).
 *   - `scoped` — sees only granted individuals and/or employees, PLUS the set
 *                connected to them, and optionally nothing in Transactions.
 *
 * THE CONNECTED SET (one level):
 *   - Grant an employee  → also see the individuals that employee works with.
 *   - Grant an individual → also see the employees who work with that individual.
 *   "Works with" = an active assignment OR a real billed transaction, unioned, so
 *   both the intended roster and the actual ledger count.
 *
 * TWO OVERRIDES: `see_all_individuals` / `see_all_employees` widen one axis to
 * everything (e.g. "this person may see every individual, but only these
 * employees"). A separate `can_see_transactions` flag hides the whole
 * Transactions surface regardless of the rest.
 *
 * Resolution is done ONCE per request and the resulting id sets are injected into
 * every list / board / grid / report query so a scoped user can never see an
 * out-of-scope row on any screen or export — the filtering is in SQL, not the UI.
 */

export interface AccessScope {
  userId: string;
  role: string;
  /** Sees everything — no filtering at all. */
  full: boolean;
  /** May the Transactions surface (grid, drill-throughs, exports) be shown. */
  canSeeTransactions: boolean;
  /** No individual filter (full, or the see-all-individuals override). */
  allIndividuals: boolean;
  /** No employee filter (full, or the see-all-employees override). */
  allEmployees: boolean;
  /** The visible individual ids (used only when !allIndividuals). */
  individualIds: string[];
  /** The visible employee ids (used only when !allEmployees). */
  employeeIds: string[];
}

/** A scope that sees everything (admins, full-access users, and the safe fallback). */
export function fullAccess(userId: string, role: string): AccessScope {
  return {
    userId,
    role,
    full: true,
    canSeeTransactions: true,
    allIndividuals: true,
    allEmployees: true,
    individualIds: [],
    employeeIds: [],
  };
}

/**
 * Resolve a user's effective access from the database. Admins are always full.
 * Everyone else follows their `access_scope` and, when scoped, their explicit
 * grants expanded by the connected set.
 */
export async function resolveAccessScope(
  pool: PgLikePool,
  user: { id: string; role: string },
): Promise<AccessScope> {
  // Only the read-only VIEWER role is ever scoped. Admins run the system and
  // managers are trusted staff, so both always see everything.
  if (user.role !== "viewer") return fullAccess(user.id, user.role);

  const { rows } = await pool.query<{
    access_scope: string;
    see_all_individuals: boolean;
    see_all_employees: boolean;
    can_see_transactions: boolean;
  }>(
    `SELECT access_scope, see_all_individuals, see_all_employees, can_see_transactions
       FROM users WHERE id = $1`,
    [user.id],
  );
  const u = rows[0];
  // No row (shouldn't happen) → safe default of full access, matching pre-feature behaviour.
  if (!u) return fullAccess(user.id, user.role);

  if (u.access_scope !== "scoped") {
    // Full-access user: sees all data, but the transactions toggle still applies.
    return {
      ...fullAccess(user.id, user.role),
      canSeeTransactions: u.can_see_transactions !== false,
    };
  }

  // Scoped: start from the explicit grants.
  const grantedIndividuals = (
    await pool.query<{ individual_id: string }>(
      `SELECT individual_id FROM user_individual_access WHERE user_id = $1`,
      [user.id],
    )
  ).rows.map((r) => r.individual_id);
  const grantedEmployees = (
    await pool.query<{ employee_id: string }>(
      `SELECT employee_id FROM user_employee_access WHERE user_id = $1`,
      [user.id],
    )
  ).rows.map((r) => r.employee_id);

  const seeAllIndividuals = u.see_all_individuals === true;
  const seeAllEmployees = u.see_all_employees === true;

  const individualIds = new Set<string>(grantedIndividuals);
  const employeeIds = new Set<string>(grantedEmployees);

  // Grant an employee → also see the individuals connected to them.
  if (!seeAllIndividuals && grantedEmployees.length > 0) {
    const connected = (
      await pool.query<{ individual_id: string }>(
        `SELECT individual_id FROM assignments
          WHERE employee_id = ANY($1::uuid[]) AND individual_id IS NOT NULL
         UNION
         SELECT individual_id FROM payroll_transactions
          WHERE employee_id = ANY($1::uuid[]) AND individual_id IS NOT NULL`,
        [grantedEmployees],
      )
    ).rows;
    for (const r of connected) individualIds.add(r.individual_id);
  }

  // Grant an individual → also see the employees connected to them.
  if (!seeAllEmployees && grantedIndividuals.length > 0) {
    const connected = (
      await pool.query<{ employee_id: string }>(
        `SELECT employee_id FROM assignments
          WHERE individual_id = ANY($1::uuid[]) AND employee_id IS NOT NULL
         UNION
         SELECT employee_id FROM payroll_transactions
          WHERE individual_id = ANY($1::uuid[]) AND employee_id IS NOT NULL`,
        [grantedIndividuals],
      )
    ).rows;
    for (const r of connected) employeeIds.add(r.employee_id);
  }

  return {
    userId: user.id,
    role: user.role,
    full: false,
    canSeeTransactions: u.can_see_transactions === true,
    allIndividuals: seeAllIndividuals,
    allEmployees: seeAllEmployees,
    individualIds: [...individualIds],
    employeeIds: [...employeeIds],
  };
}

/** May this user open this individual's page / data. */
export function canViewIndividual(scope: AccessScope, individualId: string): boolean {
  if (scope.full || scope.allIndividuals) return true;
  return scope.individualIds.includes(individualId);
}

/** May this user open this employee's page / data. */
export function canViewEmployee(scope: AccessScope, employeeId: string): boolean {
  if (scope.full || scope.allEmployees) return true;
  return scope.employeeIds.includes(employeeId);
}

/**
 * A SQL fragment restricting `column` (an individual-id column) to the visible
 * set, appended to a query's positional params. Returns "" when no filter is
 * needed (full access or the see-all-individuals override). When scoped with an
 * empty set the fragment is `= ANY('{}')`, which correctly matches nothing.
 */
export function individualScopeClause(scope: AccessScope, column: string, params: unknown[]): string {
  if (scope.full || scope.allIndividuals) return "";
  params.push(scope.individualIds);
  return ` AND ${column} = ANY($${params.length}::uuid[])`;
}

/** As above, for an employee-id column, restricted to the visible employee set. */
export function employeeScopeClause(scope: AccessScope, column: string, params: unknown[]): string {
  if (scope.full || scope.allEmployees) return "";
  params.push(scope.employeeIds);
  return ` AND ${column} = ANY($${params.length}::uuid[])`;
}

/**
 * Transaction-level rows are always scoped by the INDIVIDUAL they belong to: the
 * visible-individual set already folds in the individuals connected to any granted
 * employee, so this one predicate covers the grid, drill-throughs, employee-page
 * activity and every transaction-derived aggregate. Rows with no individual
 * (unmatched exceptions) are admin-only, so a scoped user never sees them.
 */
export function transactionScopeClause(scope: AccessScope, individualColumn: string, params: unknown[]): string {
  return individualScopeClause(scope, individualColumn, params);
}
