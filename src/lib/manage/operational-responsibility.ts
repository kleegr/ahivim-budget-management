import type { PgLikePool } from '@/lib/import/commit';
import { agencyDate } from '@/lib/business/agency-time';
import { isResponsibility, type IndividualResponsibility, type EmployeeResponsibility, type Responsibility } from '@/lib/business/operational-responsibility';
import { recordChange } from './audit';
import { fail, ok } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Owner-only read model. Reuse the audited human decision for the effective
 * agency interval. Actor IDs alone cannot prove the mutable membership value:
 * authorization triggers can overwrite it without clearing those actor IDs.
 * Agency manages_budget still governs the existing portal contract, never these
 * operational controls. Keeping its value intact prevents an access grant. */
export async function listIndividualResponsibilities(pool: PgLikePool, asOf = agencyDate(), id?: string) {
  if (id && !UUID.test(id)) return new Map<string, IndividualResponsibility>();
  const { rows } = await pool.query<{
    id: string; budget_responsibility: Responsibility | null;
    budget_responsibility_by_program: Record<string, Responsibility>;
    explicit_agency_decision: boolean | null;
  }>(`SELECT person.id, person.budget_responsibility, person.budget_responsibility_by_program,
        explicit.manages_budget AS explicit_agency_decision
      FROM individuals person
      LEFT JOIN LATERAL (
        SELECT (decision.metadata->'next'->>'managesBudget')::boolean AS manages_budget
        FROM agency_individuals membership JOIN agencies agency ON agency.id = membership.agency_id
        JOIN LATERAL (
          SELECT audit.metadata
          FROM audit_logs audit
          WHERE audit.entity_type = 'individual' AND audit.entity_id = person.id
            AND audit.action IN ('agency_individual_membership_started', 'agency_individual_membership_changed')
            AND audit.metadata->'next'->>'agencyId' = agency.id::text
            AND jsonb_typeof(audit.metadata->'next'->'managesBudget') = 'boolean'
            AND COALESCE(audit.metadata->'next'->>'effectiveFrom',
              to_char(audit.created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')) = membership.effective_from::text
          ORDER BY audit.created_at DESC, audit.id DESC LIMIT 1
        ) decision ON true
        WHERE membership.individual_id = person.id AND agency.is_home_agency
          AND agency.status = 'active' AND membership.is_active
          AND membership.effective_from <= $1::date
          AND (membership.effective_to IS NULL OR membership.effective_to >= $1::date)
        ORDER BY membership.effective_from DESC, membership.id LIMIT 1
      ) explicit ON true
      WHERE person.merged_into_id IS NULL AND ($2::uuid IS NULL OR person.id = $2)`, [asOf, id ?? null]);
  return new Map(rows.map((row): [string, IndividualResponsibility] => [row.id, {
    budget: row.budget_responsibility ?? (row.explicit_agency_decision === null ? 'undecided' : row.explicit_agency_decision ? 'managed' : 'unmanaged'),
    programs: row.budget_responsibility_by_program,
    source: row.budget_responsibility ? 'saved' : row.explicit_agency_decision === null ? 'undecided' : 'agency',
  }]));
}

export async function listEmployeeResponsibilities(pool: PgLikePool, id?: string) {
  if (id && !UUID.test(id)) return new Map<string, EmployeeResponsibility>();
  const { rows } = await pool.query<{ id: string; scheduling_responsibility: Responsibility; money_responsibility: Responsibility }>(
    `SELECT id, scheduling_responsibility, money_responsibility FROM employees
     WHERE ($1::uuid IS NULL OR id = $1)`, [id ?? null]);
  return new Map(rows.map((row): [string, EmployeeResponsibility] => [row.id, { scheduling: row.scheduling_responsibility, money: row.money_responsibility }]));
}

export async function saveOperationalResponsibility(pool: PgLikePool, kind: 'individual' | 'employee', id: string, input: Record<string, unknown>, actorId: string) {
  if (!UUID.test(id)) return fail('validation', 'Choose a valid person.');
  const field = input.field;
  const value = input.value;
  if (!isResponsibility(value)) return fail('validation', 'Choose Managed by us, Not managed by us, or Not decided yet.');
  if (kind === 'individual' ? field !== 'budget' : field !== 'scheduling' && field !== 'money') return fail('validation', 'Choose a valid responsibility.');
  if (input.programId !== undefined && input.programId !== null && typeof input.programId !== 'string') return fail('validation', 'Choose a valid program.');
  const programId = typeof input.programId === 'string' && input.programId ? input.programId : null;
  if (programId && (kind !== 'individual' || !UUID.test(programId))) return fail('validation', 'Choose a valid program.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const table = kind === 'individual' ? 'individuals' : 'employees';
    const columns = kind === 'individual' ? 'budget_responsibility, budget_responsibility_by_program' : 'scheduling_responsibility, money_responsibility';
    const previous = await client.query(`SELECT ${columns} FROM ${table} WHERE id = $1${kind === 'individual' ? ' AND merged_into_id IS NULL' : ''} FOR UPDATE`, [id]);
    if (!previous.rows.length) { await client.query('ROLLBACK'); return fail('not_found', 'Person not found.'); }
    if (programId) {
      const program = await client.query("SELECT id FROM programs WHERE id = $1 AND is_active AND archived_at IS NULL AND code <> 'CLASSES'", [programId]);
      if (!program.rows.length) { await client.query('ROLLBACK'); return fail('validation', 'Choose an active program supported by service authorizations. Class allowances remain in the Classes workspace.'); }
    }
    // Update exactly one choice: concurrent edits to other programs/employee
    // responsibilities are not overwritten. Business fields are never included.
    const updated = programId
      ? await client.query(`UPDATE individuals SET budget_responsibility_by_program = jsonb_set(budget_responsibility_by_program, ARRAY[$2::text], to_jsonb($3::text)), updated_at = now() WHERE id = $1 RETURNING ${columns}`, [id, programId, value])
      : await client.query(`UPDATE ${table} SET ${kind === 'individual' ? 'budget_responsibility' : field === 'scheduling' ? 'scheduling_responsibility' : 'money_responsibility'} = $2, updated_at = now() WHERE id = $1 RETURNING ${columns}`, [id, value]);
    await recordChange(client, { actorId, action: 'operational_responsibility_changed', entityType: kind, entityId: id, previous: previous.rows[0], next: updated.rows[0], extra: { field, programId } });
    await client.query('COMMIT');
    return ok({ saved: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
