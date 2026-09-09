import type { PgLikePool } from '@/lib/import/commit';
import { fullAccess } from '@/lib/auth/access';
import { listIndividualResponsibilities, listEmployeeResponsibilities } from '@/lib/manage/operational-responsibility';
import { reviewIndividualBudgets, reviewEmployeeSetup } from '@/lib/business/operational-review';
import { responsibilityStates, type OperationalReview } from '@/lib/business/operational-responsibility';
import { listCurrentProgramBudgets, listProgramBudgets } from './program-budgets';
import { listEmployeeDirectory } from './employee-directory';

/** Internal Owner data only. Callers must authorize before invoking this reader. */
export async function listIndividualOperationalReviews(pool: PgLikePool, today: string, id?: string) {
  const [responsibilities, currentBudgets, explicitBudgets, people, plans, programResult] = await Promise.all([
    listIndividualResponsibilities(pool, today, id),
    listCurrentProgramBudgets(pool, { asOf: today, individualId: id }),
    listProgramBudgets(pool, { individualId: id, status: "active" }),
    pool.query<{ id: string; active: boolean }>(`SELECT id, (status = 'active' AND archived_at IS NULL) AS active FROM individuals WHERE merged_into_id IS NULL AND ($1::uuid IS NULL OR id = $1)`, [id ?? null]),
    pool.query<{ id: string; individual_id: string; label: string; renewal_date: string | null }>(`SELECT strategy.id, strategy.individual_id, strategy.label, strategy.renewal_date::text FROM calculation_strategies strategy JOIN individuals person ON person.id = strategy.individual_id WHERE strategy.status = 'active' AND strategy.after_all > 0 AND person.status = 'active' AND person.archived_at IS NULL AND ($1::uuid IS NULL OR person.id = $1) AND strategy.renewal_date IS NULL`, [id ?? null]),
    pool.query<{ id: string; name: string }>("SELECT id,name FROM programs"),
  ]);
  const programNames = Object.fromEntries(programResult.rows.map((program) => [program.id, program.name]));
  const budgets = [...currentBudgets];
  const selected = new Set(budgets.map((budget) => `${budget.individualId}:${budget.programId}`));
  const candidates = [
    ...explicitBudgets.filter((budget) => budget.startDate <= today).sort((left, right) => right.endDate.localeCompare(left.endDate)),
    ...explicitBudgets.filter((budget) => budget.startDate > today).sort((left, right) => left.startDate.localeCompare(right.startDate)),
  ];
  for (const budget of candidates) {
    const key = `${budget.individualId}:${budget.programId}`;
    if (!selected.has(key)) { budgets.push(budget); selected.add(key); }
  }
  const result = new Map<string, OperationalReview>();
  for (const person of people.rows) {
    const responsibility = responsibilities.get(person.id);
    if (!responsibility) continue;
    const flags = reviewIndividualBudgets({ id: person.id, active: person.active, responsibility, programNames, budgets: budgets.filter((budget) => budget.individualId === person.id), today });
    for (const plan of plans.rows.filter((plan) => plan.individual_id === person.id)) flags.push({ key: `financial-renewal-${plan.id}`, message: `${plan.label}: approved monthly put-away needs a renewal date before the affected period can run.`, action: 'Edit Financial Setup renewal', href: `/individuals/${person.id}?view=financial#financial-plan-${plan.id}` });
    result.set(person.id, { responsibility, flags });
  }
  return result;
}

export async function getOperationalReviewSummary(pool: PgLikePool, today: string) {
  const [individuals, activePeople, employees, employeeResponsibilities] = await Promise.all([
    listIndividualOperationalReviews(pool, today),
    pool.query<{ id: string }>("SELECT id FROM individuals WHERE status = 'active' AND archived_at IS NULL AND merged_into_id IS NULL"),
    listEmployeeDirectory(pool, fullAccess('operational-owner-summary', 'admin')),
    listEmployeeResponsibilities(pool),
  ]);
  const activeIndividuals = activePeople.rows.map((person) => individuals.get(person.id)).filter((value): value is OperationalReview => !!value);
  const activeEmployees = employees.filter((person) => person.status === 'active' && !person.archivedAt);
  return {
    individuals: activeIndividuals.filter((person) => person.flags.length > 0).length,
    employees: activeEmployees.filter((person) => reviewEmployeeSetup(person).length > 0).length,
    undecidedIndividuals: activeIndividuals.filter((person) => responsibilityStates(person.responsibility).includes('undecided')).length,
    undecidedEmployees: activeEmployees.filter((person) => { const value = employeeResponsibilities.get(person.id); return !value || value.money === 'undecided' || value.scheduling === 'undecided'; }).length,
  };
}
