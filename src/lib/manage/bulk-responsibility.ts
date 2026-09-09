import { createHash } from "node:crypto";
import type { PgLikePool } from "@/lib/import/commit";
import { canViewIndividual, type AccessScope } from "@/lib/auth/access";
import { isResponsibility, type Responsibility } from "@/lib/business/operational-responsibility";
import { recordChange } from "./audit";
import { fail, ok } from "./errors";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_RESPONSIBILITY_BATCH = 100;
export interface ResponsibilityTarget { id: string; name: string; version: string; general: Responsibility | null; programs: Record<string, Responsibility> }
export interface ResponsibilityChanges { general?: Responsibility; programs?: Record<string, Responsibility> }
function validIds(ids: unknown): ids is string[] { return Array.isArray(ids) && ids.length > 0 && ids.length <= MAX_RESPONSIBILITY_BATCH && ids.every((id) => typeof id === "string" && UUID.test(id)) && new Set(ids).size === ids.length; }
function validChanges(changes: unknown): changes is ResponsibilityChanges {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return false;
  const input = changes as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "general" && key !== "programs")) return false;
  if ("general" in input && !isResponsibility(input.general)) return false;
  if ("programs" in input && (!input.programs || typeof input.programs !== "object" || Array.isArray(input.programs) || Object.entries(input.programs).some(([id, value]) => !UUID.test(id) || !isResponsibility(value)))) return false;
  return "general" in input || Object.keys(input.programs ?? {}).length > 0;
}
export async function previewBulkResponsibility(pool: PgLikePool, scope: AccessScope, ids: unknown) {
  if (!validIds(ids)) return fail("validation", `Choose between 1 and ${MAX_RESPONSIBILITY_BATCH} distinct people per batch.`);
  if (ids.some((id) => !canViewIndividual(scope, id))) return fail("forbidden", "One or more people are outside your access.");
  const result = await pool.query<{ id: string; name: string; version: string; general: Responsibility | null; programs: Record<string, Responsibility> }>(
    `SELECT id, display_name AS name, updated_at::text AS version, budget_responsibility AS general,
       budget_responsibility_by_program AS programs FROM individuals
     WHERE id = ANY($1::uuid[]) AND merged_into_id IS NULL ORDER BY id`, [ids]);
  return result.rows.length === ids.length ? ok(result.rows) : fail("conflict", "A selected person is no longer available. Refresh the selection.");
}
export async function saveBulkResponsibility(pool: PgLikePool, scope: AccessScope, input: Record<string, unknown>, actorId: string) {
  if (Object.keys(input).some((key) => !["batchId", "targets", "changes", "reason"].includes(key))) return fail("validation", "Only responsibility fields can be changed here.");
  if (typeof input.batchId !== "string" || !UUID.test(input.batchId) || !validChanges(input.changes)) return fail("validation", "Choose responsibility fields and a valid batch identity.");
  const targets = input.targets;
  if (!Array.isArray(targets) || targets.some((target) => !target || typeof target !== "object" || typeof target.version !== "string") || !validIds(targets.map((target) => target.id))) return fail("validation", "Preview the selected people before saving.");
  if (targets.some((target) => !canViewIndividual(scope, target.id))) return fail("forbidden", "One or more people are outside your access.");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason || reason.length > 500) return fail("validation", "Enter a reason of up to 500 characters.");
  const changes = input.changes;
  const requestHash = createHash("sha256").update(JSON.stringify({ actorId, targets: [...targets].sort((a, b) => a.id.localeCompare(b.id)), changes, reason })).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`responsibility-batch:${input.batchId}`]);
    const retry = await client.query<{ metadata: { requestHash: string; count: number } }>("SELECT metadata FROM audit_logs WHERE action = 'operational_responsibility_batch_completed' AND entity_id = $1 ORDER BY created_at DESC LIMIT 1", [input.batchId]);
    if (retry.rows[0]) { await client.query("ROLLBACK"); return retry.rows[0].metadata.requestHash === requestHash ? ok({ batchId: input.batchId, count: retry.rows[0].metadata.count, repeated: true }) : fail("conflict", "This batch identity was already used for different changes."); }
    const programs = Object.keys(changes.programs ?? {});
    if (programs.length) {
      const available = await client.query("SELECT id FROM programs WHERE id = ANY($1::uuid[]) AND is_active AND archived_at IS NULL AND code <> 'CLASSES'", [programs]);
      if (available.rows.length !== programs.length) { await client.query("ROLLBACK"); return fail("validation", "Choose active service programs."); }
    }
    const rows = await client.query<ResponsibilityTarget>(`SELECT id, display_name AS name, updated_at::text AS version, budget_responsibility AS general, budget_responsibility_by_program AS programs
      FROM individuals WHERE id = ANY($1::uuid[]) AND merged_into_id IS NULL ORDER BY id FOR UPDATE`, [targets.map((target) => target.id)]);
    if (rows.rows.length !== targets.length || rows.rows.some((row) => targets.find((target) => target.id === row.id)?.version !== row.version)) {
      await client.query("ROLLBACK"); return fail("conflict", "A selected record changed after preview. No people were updated. Preview again; your field choices are retained.");
    }
    for (const row of rows.rows) {
      const next = { general: changes.general ?? row.general, programs: { ...row.programs, ...changes.programs } };
      await client.query("UPDATE individuals SET budget_responsibility = $2, budget_responsibility_by_program = $3::jsonb, updated_at = now() WHERE id = $1", [row.id, next.general, JSON.stringify(next.programs)]);
      await recordChange(client, { actorId, action: "operational_responsibility_changed", entityType: "individual", entityId: row.id, previous: { general: row.general, programs: row.programs }, next, reason, extra: { batchId: input.batchId, chosenFields: changes } });
    }
    await recordChange(client, { actorId, action: "operational_responsibility_batch_completed", entityType: "responsibility_batch", entityId: input.batchId, reason, extra: { requestHash, count: rows.rows.length, ids: rows.rows.map((row) => row.id) } });
    await client.query("COMMIT");
    return ok({ batchId: input.batchId, count: rows.rows.length, repeated: false });
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}
