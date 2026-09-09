import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { apiPortalUser } from "@/lib/auth/portal-api";
import { resolveAccessScope } from "@/lib/auth/access";
import { previewBulkResponsibility, saveBulkResponsibility } from "@/lib/manage/bulk-responsibility";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const origin = sameOriginOrFail(request); if (origin) return origin;
  try {
    const auth = await apiPortalUser("agencies.manage");
    if (!auth) return jsonError("Management access required", 403);
    const scope = await resolveAccessScope(auth.pool, auth.user);
    const input = await readJson(request);
    if (input.action === "preview") {
      const result = await previewBulkResponsibility(auth.pool, scope, input.ids);
      if (!result.ok) return resultResponse(result);
      const programs = await auth.pool.query<{ id: string; name: string }>("SELECT id, name FROM programs WHERE is_active AND archived_at IS NULL AND code <> 'CLASSES' ORDER BY name");
      return NextResponse.json({ ok: true, data: { targets: result.data, programs: programs.rows } });
    }
    const result = await saveBulkResponsibility(auth.pool, scope, input, auth.user.actorId);
    if (result.ok) { revalidatePath("/individuals"); revalidatePath("/individuals/[id]", "page"); revalidatePath("/dashboard"); }
    return resultResponse(result);
  } catch (error) { return jsonError(redactError(error, "Could not save the responsibility batch. Retry with the same selection."), 500); }
}
