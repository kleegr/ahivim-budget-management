import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { apiPortalUser } from '@/lib/auth/portal-api';
import { canViewIndividual, resolveAccessScope } from '@/lib/auth/access';
import { listIndividualResponsibilities, saveOperationalResponsibility } from '@/lib/manage/operational-responsibility';
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from '@/lib/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const authorized = await apiPortalUser('agencies.manage');
    if (!authorized) return jsonError('Owner access required', 403);
    const { id } = await params;
    if (!canViewIndividual(await resolveAccessScope(authorized.pool, authorized.user), id)) return jsonError('Person access required', 403);
    const value = (await listIndividualResponsibilities(authorized.pool, undefined, id)).get(id);
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
    if (!canViewIndividual(await resolveAccessScope(authorized.pool, authorized.user), id)) return jsonError('Person access required', 403);
    const result = await saveOperationalResponsibility(authorized.pool, 'individual', id, await readJson(request), authorized.user.actorId);
    if (result.ok) { revalidatePath(`/individuals/${id}`); revalidatePath('/individuals'); revalidatePath('/dashboard'); }
    return resultResponse(result);
  } catch (error) { return jsonError(redactError(error, 'Could not save responsibility. Your choice has not been changed.'), 500); }
}
