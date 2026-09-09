import { describe, expect, it } from 'vitest';
import { reviewIndividualBudgets, reviewEmployeeSetup } from '@/lib/business/operational-review';
import { matchesOperationalFilters, responsibilityForProgram, type IndividualResponsibility } from '@/lib/business/operational-responsibility';
import type { ProgramBudgetRecord } from '@/lib/data/program-budgets';
import { individualNextAction } from '@/components/individuals/people-budget-table';

const responsibility: IndividualResponsibility = { budget: 'undecided', programs: {}, source: 'undecided' };
const budget = { authorizationId: 'auth-1', individualId: 'person', programId: 'program-1', programName: 'Community support', startDate: '2026-01-01', endDate: '2026-12-31', renewalDate: null, renewalPolicy: 'individual', remainingHours: '10', remainingDollars: null, remainingAfterScheduledHours: '5', sourceCandidateCount: 1, hasUndatedUsage: false } as ProgramBudgetRecord;
const review = (choice: IndividualResponsibility, budgets: ProgramBudgetRecord[] = []) => reviewIndividualBudgets({ id: 'person', active: true, responsibility: choice, budgets, today: '2026-09-08' });

describe('operational responsibility and record review', () => {
  it('treats undecided and unmanaged without a budget as neutral, even with transactions', () => {
    for (const value of ['undecided', 'unmanaged'] as const) {
      const r = { ...responsibility, budget: value };
      expect(review(r)).toEqual([]);
      expect(individualNextAction({ id: 'person', status: 'active', archived: false, programs: [], budget: null, hasCanonicalBudget: false, hasBilling: true, insightsVisible: true, operationalReview: { responsibility: r, flags: [] } }).tone).toBe('muted');
    }
  });
  it('flags only the managed program setup and points to its exact authorization', () => {
    const r = { ...responsibility, budget: 'managed' as const, programs: { 'program-2': 'unmanaged' as const } };
    const flags = review(r, [budget, { ...budget, authorizationId: 'auth-2', programId: 'program-2' }]);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ key: 'renewal-missing-auth-1', action: 'Set renewal date', href: '/individuals/person?view=budget#authorization-auth-1' });
    expect(responsibilityForProgram(r, 'program-2')).toBe('unmanaged');
    expect(review(r, [{ ...budget, renewalDate: '2027-01-01' }, { ...budget, programId: 'program-2' }])).toEqual([]);
  });
  it('keeps date conflicts, source discrepancies, and overages when unmanaged', () => {
    const flags = review({ ...responsibility, budget: 'unmanaged' }, [{ ...budget, renewalDate: '2025-01-01', hasUndatedUsage: true, remainingHours: '-3', sourceCandidateCount: 2 }]);
    expect(flags.map((flag) => flag.key)).toEqual(['dates-auth-1', 'undated-auth-1', 'sources-auth-1', 'over-auth-1']);
    expect(flags.find((flag) => flag.key.startsWith('undated'))?.href).toContain('/transactions?individualId=person&programId=program-1');
  });
  it('flags managed missing programs and expired periods without requiring dates for calendar budgets', () => {
    expect(review({ ...responsibility, programs: { 'program-1': 'managed' } })[0].key).toBe('missing-budget-program-1');
    expect(review({ ...responsibility, budget: 'managed' }, [{ ...budget, renewalPolicy: 'calendar' }])).toEqual([]);
    expect(review({ ...responsibility, budget: 'managed' }, [{ ...budget, renewalDate: '2026-01-01', startDate: '2025-01-01', endDate: '2025-12-31' }])[0].key).toBe('expired-auth-1');
  });
  it('filters mixed responsibility and detected issues without treating unknown as an error', () => {
    expect(matchesOperationalFilters(['managed', 'unmanaged'], [], 'unmanaged', 'clear')).toBe(true);
    expect(matchesOperationalFilters(['undecided'], [], 'undecided', 'needs_review')).toBe(false);
    expect(reviewEmployeeSetup({ id: 'employee', missingDealTransactions: null })).toEqual([]);
    expect(reviewEmployeeSetup({ id: 'employee', missingDealTransactions: 3 })[0].href).toBe('/employees/employee?view=money#employee-arrangements');
  });
  it('does not offer an impossible missing-authorization action for an unavailable program', () => {
    expect(reviewIndividualBudgets({ id: 'person', active: true, responsibility: { ...responsibility, programs: { archived: 'managed' } }, budgets: [], today: '2026-09-08', programNames: { active: 'Active program' } })).toEqual([]);
  });
});
