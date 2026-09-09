import { responsibilityForProgram, type IndividualResponsibility, type OperationalFlag } from './operational-responsibility';
import type { ProgramBudgetRecord } from '@/lib/data/program-budgets';
import { dec } from '@/lib/money';

export function reviewIndividualBudgets(input: {
  id: string; active: boolean; responsibility: IndividualResponsibility;
  budgets: ProgramBudgetRecord[]; today: string; programNames?: Record<string, string>;
}): OperationalFlag[] {
  const flags: OperationalFlag[] = [];
  const base = `/individuals/${input.id}?view=budget`;
  const managedMissing = Object.entries(input.responsibility.programs).filter(([programId, value]) => value === 'managed' && (!input.programNames || programId in input.programNames) && !input.budgets.some((budget) => budget.programId === programId));
  if (input.active && input.responsibility.budget === 'managed' && input.budgets.length === 0 && managedMissing.length === 0) {
    flags.push({ key: 'missing-budget', message: 'Budget managed here; no authorization is saved.', action: 'Add budget', href: `${base}#service-authorizations` });
  }
  for (const [programId] of input.active ? managedMissing : []) {
    flags.push({ key: `missing-budget-${programId}`, message: `${input.programNames?.[programId] ?? 'Managed program'}: no authorization is saved.`, action: 'Add program budget', href: `${base}#service-authorizations`, programId });
  }
  for (const budget of input.budgets) {
    const href = `${base}#authorization-${budget.authorizationId}`;
    const add = (key: string, message: string, action: string, target = href) => flags.push({ key: `${key}-${budget.authorizationId}`, message: `${budget.programName}: ${message}`, action, href: target, programId: budget.programId });
    // Source-integrity and real overages are independent of who manages setup.
    if (budget.startDate > budget.endDate || (budget.renewalDate && budget.renewalDate <= budget.startDate)) add('dates', 'saved authorization dates conflict.', 'Correct dates');
    if (budget.hasUndatedUsage) add('undated', 'usage has no usable service date; remaining allowance is incomplete.', 'Review source transactions', `/transactions?individualId=${input.id}&programId=${budget.programId}`);
    if (budget.sourceCandidateCount > 1) add('sources', 'multiple active financial plans provide this program.', 'Review financial setup', `/individuals/${input.id}?view=financial#financial-setup`);
    if (dec(budget.remainingHours).lessThan(0) || (budget.remainingDollars !== null && dec(budget.remainingDollars).lessThan(0))) add('over', 'recorded usage exceeds the authorization.', 'Review authorization');
    if (input.active && dec(budget.remainingAfterScheduledHours).lessThan(0) && !dec(budget.remainingHours).lessThan(0)) add('schedule-over', 'scheduled hours exceed remaining hours.', 'Review schedule', `/schedule?individualId=${input.id}&view=coverage`);
    if (!input.active || responsibilityForProgram(input.responsibility, budget.programId) !== 'managed') continue;
    if (budget.renewalPolicy !== 'calendar' && !budget.renewalDate) add('renewal-missing', 'renewal date is missing.', 'Set renewal date');
    else if (budget.endDate < input.today || (budget.renewalDate && budget.renewalDate < input.today)) add('expired', 'managed authorization has expired.', 'Renew authorization');
  }
  return flags;
}

export function reviewEmployeeSetup(input: { id: string; missingDealTransactions: number | null }): OperationalFlag[] {
  return (input.missingDealTransactions ?? 0) > 0 ? [{
    key: 'missing-effective-deal',
    message: 'Source transactions have no applicable employee arrangement; dependent balances may be incomplete.',
    action: 'Review arrangements', href: `/employees/${input.id}?view=money#employee-arrangements`,
  }] : [];
}
