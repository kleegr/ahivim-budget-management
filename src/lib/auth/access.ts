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
 * Resolution is done ONCE per request. Expanded id sets govern which person pages
 * may be opened; explicit grant sets govern ledger rows. Both are injected into
 * SQL queries, so authorization never depends on client-side hiding.
 */

export interface VisibilityPermissions {
  /** Compatibility/master switch: false suppresses every monetary category. */
  canSeeMoney: boolean;
  canSeeHours: boolean;
  canSeeBilledAmounts: boolean;
  canSeeEmployeeAmounts: boolean;
  canSeeAgencySpread: boolean;
  canSeeCheckNet: boolean;
  canSeeTaxes: boolean;
  canSeeBudgets: boolean;
  canSeeEmployeeDeals: boolean;
  canSeeSettlements: boolean;
  /** May view class budgets, invoices, and generated class documents. */
  canSeeClassFinancials: boolean;
  /** May configure class revenue and create, issue, or void class invoices. */
  canManageClassInvoices: boolean;
}

export interface AccessScope extends VisibilityPermissions {
  userId: string;
  role: string;
  /** Sees everything — no filtering at all. */
  full: boolean;
  /** May the Transactions surface (grid, drill-throughs, exports) be shown. */
  canSeeTransactions: boolean;
  /** May this account read and manage the operational Planning workspace. */
  canPlan: boolean;
  /** May use the PDF editing workspace. Independent of money permissions. */
  canEditDocuments: boolean;
  /** No individual filter (full, or the see-all-individuals override). */
  allIndividuals: boolean;
  /** No employee filter (full, or the see-all-employees override). */
  allEmployees: boolean;
  /** Individuals visible for navigation, including connected people. */
  individualIds: string[];
  /** Employees visible for navigation, including connected people. */
  employeeIds: string[];
  /** Individuals granted directly by an administrator, before navigation expansion. */
  grantedIndividualIds: string[];
  /** Employees granted directly by an administrator, before navigation expansion. */
  grantedEmployeeIds: string[];
}

/** A scope that sees everything (admins, full-access users, and the safe fallback). */
export function fullAccess(userId: string, role: string): AccessScope {
  return {
    userId,
    role,
    full: true,
    canSeeTransactions: true,
    canSeeMoney: true,
    canSeeHours: true,
    canSeeBilledAmounts: true,
    canSeeEmployeeAmounts: true,
    canSeeAgencySpread: true,
    canSeeCheckNet: true,
    canSeeTaxes: true,
    canSeeBudgets: true,
    canSeeEmployeeDeals: true,
    canSeeSettlements: true,
    canSeeClassFinancials: true,
    canManageClassInvoices: true,
    canEditDocuments: true,
    canPlan: true,
    allIndividuals: true,
    allEmployees: true,
    individualIds: [],
    employeeIds: [],
    grantedIndividualIds: [],
    grantedEmployeeIds: [],
  };
}

/**
 * Planning currently operates across the whole employee/individual roster.
 * Keep a partially scoped account out until schedule queries can enforce both
 * axes themselves; this prevents a narrow people grant from widening through
 * the portfolio-wide calendar APIs.
 */
export function canAccessPlanning(
  scope: Pick<AccessScope, "canPlan" | "full" | "allIndividuals" | "allEmployees">,
): boolean {
  return scope.canPlan && (scope.full || (scope.allIndividuals && scope.allEmployees));
}

/** Dedicated planner profile: Planning and hours, without ledger or money access. */
export function isPlanningOnlyAccess(
  scope: Pick<
    AccessScope,
    "canPlan" | "full" | "allIndividuals" | "allEmployees" | "canSeeTransactions" | "canSeeMoney"
  >,
): boolean {
  return canAccessPlanning(scope) && !scope.canSeeTransactions && !scope.canSeeMoney;
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
  // Only the restricted VIEWER role is ever scoped. It is view-only by default,
  // but an administrator can grant narrow operational actions such as recording
  // payments. Admins and managers always retain full access.
  if (user.role !== "viewer") return fullAccess(user.id, user.role);

  const { rows } = await pool.query<{
    access_scope: string;
    see_all_individuals: boolean;
    see_all_employees: boolean;
    can_see_transactions: boolean;
    can_see_money: boolean;
    can_see_hours: boolean;
    can_see_billed_amounts: boolean;
    can_see_employee_amounts: boolean;
    can_see_agency_spread: boolean;
    can_see_check_net: boolean;
    can_see_taxes: boolean;
    can_see_budgets: boolean;
    can_see_employee_deals: boolean;
    can_see_settlements: boolean;
    can_plan: boolean;
    can_see_class_financials: boolean;
    can_manage_class_invoices: boolean;
    can_edit_documents: boolean;
  }>(
    `SELECT access_scope, see_all_individuals, see_all_employees, can_see_transactions, can_see_money,
            can_see_hours, can_see_billed_amounts, can_see_employee_amounts,
            can_see_agency_spread, can_see_check_net, can_see_taxes,
            can_see_budgets, can_see_employee_deals, can_see_settlements, can_plan,
            can_see_class_financials, can_manage_class_invoices, can_edit_documents
       FROM users WHERE id = $1`,
    [user.id],
  );
  const u = rows[0];
  // The account was present when the session was checked, but it may have been
  // removed or deactivated before this query. Fail closed during that race.
  if (!u) {
    return {
      userId: user.id,
      role: user.role,
      full: false,
      canSeeTransactions: false,
      canSeeMoney: false,
      canSeeHours: false,
      canSeeBilledAmounts: false,
      canSeeEmployeeAmounts: false,
      canSeeAgencySpread: false,
      canSeeCheckNet: false,
      canSeeTaxes: false,
      canSeeBudgets: false,
      canSeeEmployeeDeals: false,
      canSeeSettlements: false,
      canSeeClassFinancials: false,
      canManageClassInvoices: false,
      canEditDocuments: false,
      canPlan: false,
      allIndividuals: false,
      allEmployees: false,
      individualIds: [],
      employeeIds: [],
      grantedIndividualIds: [],
      grantedEmployeeIds: [],
    };
  }

  const canSeeMoney = u.can_see_money !== false;
  const canSeeHours = u.can_see_hours !== false;
  const visibility: VisibilityPermissions = {
    canSeeMoney,
    canSeeHours,
    canSeeBilledAmounts: canSeeMoney && u.can_see_billed_amounts !== false,
    canSeeEmployeeAmounts: canSeeMoney && u.can_see_employee_amounts !== false,
    canSeeAgencySpread: canSeeMoney && u.can_see_agency_spread !== false,
    canSeeCheckNet: canSeeMoney && u.can_see_check_net !== false,
    canSeeTaxes: canSeeMoney && u.can_see_taxes !== false,
    canSeeBudgets: canSeeHours && u.can_see_budgets !== false,
    canSeeEmployeeDeals: canSeeMoney && u.can_see_employee_deals === true,
    canSeeSettlements: canSeeMoney && u.can_see_settlements === true,
    canSeeClassFinancials: canSeeMoney && u.can_see_class_financials === true,
    canManageClassInvoices:
      canSeeMoney
      && u.can_see_class_financials === true
      && u.can_manage_class_invoices === true,
  };
  const canPlan = u.can_plan === true;
  const canEditDocuments = u.can_edit_documents === true;

  if (u.access_scope !== "scoped") {
    // Full-access user: sees all data, but the transactions / money toggles still apply.
    return {
      ...fullAccess(user.id, user.role),
      canSeeTransactions: u.can_see_transactions !== false,
      ...visibility,
      canPlan,
      canEditDocuments,
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
    ...visibility,
    canPlan,
    canEditDocuments,
    allIndividuals: seeAllIndividuals,
    allEmployees: seeAllEmployees,
    individualIds: [...individualIds],
    employeeIds: [...employeeIds],
    grantedIndividualIds: grantedIndividuals,
    grantedEmployeeIds: grantedEmployees,
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

/** Sensitive employee data requires an explicit grant, not navigation expansion. */
export function hasDirectEmployeeAccess(scope: AccessScope, employeeId: string): boolean {
  return scope.full || scope.allEmployees || scope.grantedEmployeeIds.includes(employeeId);
}

/** Sensitive individual data requires an explicit grant, not navigation expansion. */
export function hasDirectIndividualAccess(scope: AccessScope, individualId: string): boolean {
  return scope.full || scope.allIndividuals || scope.grantedIndividualIds.includes(individualId);
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
 * Restrict transaction rows to the grants an administrator made explicitly.
 * Connected people remain visible for navigation, but never grant ledger access:
 * an individual grant permits that individual's rows, while an employee grant
 * permits only that employee's rows. The see-all switches act as wildcard grants
 * on their respective axes. Rows unmatched on both axes remain full-access only.
 */
export function transactionScopeClause(
  scope: AccessScope,
  individualColumn: string,
  employeeColumn: string,
  params: unknown[],
): string {
  if (scope.full) return "";

  const permitted: string[] = [];

  if (scope.allIndividuals) {
    permitted.push(`${individualColumn} IS NOT NULL`);
  } else if (scope.grantedIndividualIds.length > 0) {
    params.push(scope.grantedIndividualIds);
    permitted.push(`${individualColumn} = ANY($${params.length}::uuid[])`);
  }

  if (scope.allEmployees) {
    permitted.push(`${employeeColumn} IS NOT NULL`);
  } else if (scope.grantedEmployeeIds.length > 0) {
    params.push(scope.grantedEmployeeIds);
    permitted.push(`${employeeColumn} = ANY($${params.length}::uuid[])`);
  }

  return permitted.length > 0 ? ` AND (${permitted.join(" OR ")})` : " AND FALSE";
}
