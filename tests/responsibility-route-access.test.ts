import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { fullAccess, type AccessScope } from '@/lib/auth/access';
const state = vi.hoisted(() => ({ scope: null as AccessScope | null, authorized: true, read: vi.fn(), save: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/access', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/auth/access')>(), resolveAccessScope: async () => state.scope }));
vi.mock('@/lib/auth/portal-api', () => ({ apiPortalUser: async () => state.authorized ? { pool: {}, user: { id: 'preview-user', actorId: 'real-owner' } } : null }));
vi.mock('@/lib/manage/operational-responsibility', () => ({ listIndividualResponsibilities: (...args: unknown[]) => state.read(...args), listEmployeeResponsibilities: (...args: unknown[]) => state.read(...args), saveOperationalResponsibility: (...args: unknown[]) => state.save(...args) }));
import { GET as getIndividual, PATCH as patchIndividual } from '@/app/api/individuals/[id]/responsibility/route';
import { GET as getEmployee, PATCH as patchEmployee } from '@/app/api/employees/[id]/responsibility/route';
const id = '10000000-0000-4000-8000-000000000001';
const params = { params: Promise.resolve({ id }) };
const request = () => new NextRequest(`http://localhost/api/individuals/${id}/responsibility`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' }, body: JSON.stringify({ field: 'budget', value: 'managed', expectedValue: 'undecided' }) });
beforeEach(() => { state.authorized = true; state.scope = fullAccess('preview-user', 'admin'); state.read.mockReset(); state.save.mockReset(); state.save.mockResolvedValue({ ok: true, data: { saved: true } }); });
describe('responsibility endpoint person scope', () => {
  it('denies both reads and writes before loading hidden person responsibility', async () => {
    state.scope = { ...state.scope!, full: false, allIndividuals: false, allEmployees: false, individualIds: [], employeeIds: [] };
    for (const handler of [getIndividual, getEmployee, patchIndividual, patchEmployee]) expect((await handler(request(), params)).status).toBe(403);
    expect(state.read).not.toHaveBeenCalled(); expect(state.save).not.toHaveBeenCalled();
  });
  it('records the actual actor when an authorized owner previews another account', async () => {
    expect((await patchIndividual(request(), params)).status).toBe(200);
    expect(state.save).toHaveBeenCalledWith({}, 'individual', id, { field: 'budget', value: 'managed', expectedValue: 'undecided' }, 'real-owner');
  });
});
