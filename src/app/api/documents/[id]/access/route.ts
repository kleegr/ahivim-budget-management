import { type NextRequest, NextResponse } from "next/server";
import { accessibleDocument } from "@/lib/document-route-helpers";
import { jsonError, readJson, redactError, resultResponse, sameOriginOrFail } from "@/lib/http";
import { updateDocumentAccess } from "@/lib/manage/document-policy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const found = await accessibleDocument(id, "edit");
    if ("error" in found) return found.error;
    if (found.access.user.role !== "admin" || found.access.scope.role !== "admin") return jsonError("Owner access required.", 403);
    const pool = found.access.pool;
    const [individuals, employees, users, agencies, publications, versions] = await Promise.all([
      pool.query(`SELECT id, display_name AS name FROM individuals ORDER BY display_name`),
      pool.query(`SELECT id, display_name AS name FROM employees ORDER BY display_name`),
      pool.query(`SELECT id, display_name AS name FROM users WHERE is_active ORDER BY display_name`),
      pool.query(`SELECT id, name FROM agencies WHERE status = 'active' ORDER BY name`),
      pool.query(`SELECT p.user_id, p.title, u.display_name AS name FROM document_publications p JOIN users u ON u.id = p.user_id WHERE p.document_id = $1`, [id]),
      pool.query(`SELECT id, version_number AS number FROM document_versions WHERE document_id = $1 AND export_mode = 'secure' ORDER BY version_number DESC`, [id]),
    ]);
    return NextResponse.json({ ok: true, data: {
      context: found.document.accessContext, individuals: individuals.rows, employees: employees.rows,
      users: users.rows, agencies: agencies.rows, publications: publications.rows, versions: versions.rows,
    } });
  } catch (error) { return jsonError(redactError(error, "Could not load document access."), 500); }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const cross = sameOriginOrFail(request);
  if (cross) return cross;
  const { id } = await params;
  try {
    const found = await accessibleDocument(id, "edit");
    if ("error" in found) return found.error;
    return resultResponse(await updateDocumentAccess(found.access, id, await readJson(request)));
  } catch (error) { return jsonError(redactError(error, "Could not update document access."), 500); }
}
