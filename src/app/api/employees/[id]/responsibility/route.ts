import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { apiPortalUser } from '@/lib/auth/portal-api';
import { listEmployeeResponsibilities, saveOperationalResponsibility } from '@/lib/manage/operational-responsibility';
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from '@/lib/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authorized = await apiPortalUser('agencies.manage');
    if (!authorized) return jsonError('Owner access required', 403);
    const { id } = await params;
    const value = (await listEmployeeResponsibilities(authorized.pool, id)).get(id);
    return value ? NextResponse.json({ ok: true, data: value }) : jsonError('Person not found', 404);
  } catch (error) { return jsonError(redactError(error, 'Could not load responsibility. Try again.'), 500); }
}
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = sameOriginOrFail(request);
  if (origin) return origin;
  try {
    const authorized = await apiPortalUser('agencies.manage');
    if (!authorized) return jsonError('Owner access required', 403);
    const { id } = await params;
    const result = await saveOperationalResponsibility(authorized.pool, 'employee', id, await readJson(request), authorized.user.id);
    if (result.ok) { revalidatePath(`/employees/${id}`); revalidatePath('/employees'); revalidatePath('/dashboard'); }
    return resultResponse(result);
  } catch (error) { return jsonError(redactError(error, 'Could not save responsibility. Your choice has not been changed.'), 500); }
}
