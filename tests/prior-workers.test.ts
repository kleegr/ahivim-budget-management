import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PriorWorkers from '@/components/individuals/prior-workers';
import { listPriorWorkers } from '@/lib/data/prior-workers';
import { fullAccess } from '@/lib/auth/access';
import type { AssignmentRecord } from '@/lib/manage/assignments';
import type { PgLikePool } from '@/lib/import/commit';
const worker = { employeeId: 'employee-one', employeeName: 'Same Name', programId: 'program-one', programName: 'ComHab', lastServiceDate: '2026-08-28' };
const assignment = (overrides: Partial<AssignmentRecord>): AssignmentRecord => ({ id: 'assignment-one', individualId: 'person-one', individualName: 'Person', employeeId: worker.employeeId, employeeName: worker.employeeName, programId: worker.programId, programName: worker.programName, startDate: '2026-01-01', endDate: null, status: 'active', allowedHours: null, notes: null, createdAt: '2026-01-01', ...overrides });
afterEach(() => vi.useRealTimers());
describe('prior worker planning context', () => {
  it('reuses the current or future matching assignment after an ended historical assignment', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-09T12:00:00Z'));
    const html = renderToStaticMarkup(React.createElement(PriorWorkers, { individualId: 'person-one', workers: [worker], assignments: [assignment({ id: 'old', endDate: '2026-06-30', status: 'ended' }), assignment({ id: 'future', startDate: '2026-10-01' })] }));
    expect(html).toContain('Open existing assignment');
    expect(html).toContain('programId=program-one&amp;assignmentId=future');
    expect(html).not.toContain('newAssignment=1"&gt;Create');
  });
  it('uses separate IDs for identical names and excludes unrelated assignments from reuse', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-09T12:00:00Z'));
    const html = renderToStaticMarkup(React.createElement(PriorWorkers, { individualId: 'person-one', workers: [worker, { ...worker, employeeId: 'employee-two' }], assignments: [assignment({ programId: 'other-program' })] }));
    expect(html.match(/Create prefilled assignment/g)).toHaveLength(2);
    expect(html).toContain('employeeId=employee-one'); expect(html).toContain('employeeId=employee-two');
  });
  it('does not query outside the authorized individual scope or when planning is disabled', async () => {
    const query = vi.fn(); const pool = { query } as unknown as PgLikePool;
    const base = fullAccess('user', 'admin');
    expect(await listPriorWorkers(pool, { ...base, full: false, allIndividuals: false, individualIds: [] }, 'hidden-person')).toEqual([]);
    expect(await listPriorWorkers(pool, { ...base, canPlan: false }, 'person-one')).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
  it('retains historical context without offering an ineligible inactive worker as a new assignment', () => {
    const html = renderToStaticMarkup(React.createElement(PriorWorkers, { individualId: 'person-one', workers: [{ ...worker, canCreateAssignment: false }], assignments: [] }));
    expect(html).toContain('Same Name'); expect(html).toContain('Inactive employee or program');
    expect(html).not.toContain('Create prefilled assignment');
  });
});
