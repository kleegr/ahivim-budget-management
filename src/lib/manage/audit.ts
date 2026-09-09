import type { PgLikePool, PgLikeClient } from "@/lib/import/commit";
import { resolveAuditAttribution } from "@/lib/auth/audit-attribution";

/**
 * The single place a change is recorded.
 *
 * Every operational edit in the application funnels through here so the audit
 * trail is complete and uniform: who, when, what record, the previous value,
 * the new value, and the reason. `previous`/`next` are stored in the metadata
 * JSON; `reason` is a first-class column so it can be filtered and reported.
 */
export interface ChangeEntry {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  previous?: unknown;
  next?: unknown;
  reason?: string | null;
  extra?: Record<string, unknown>;
}

type Queryable = Pick<PgLikePool, "query"> | Pick<PgLikeClient, "query">;

/** Insert a bounded mutation's per-record history on the caller's transaction. */
export async function recordChanges(db: Queryable, entries: ChangeEntry[]): Promise<void> {
  if (!entries.length) return;
  const attribution = await resolveAuditAttribution(entries[0]!.actorId);
  const rows = entries.map(entry => ({
    action: entry.action, entity_type: entry.entityType, entity_id: entry.entityId,
    reason: entry.reason ?? null,
    metadata: { ...entry.extra, previous: entry.previous, next: entry.next,
      ...(attribution.impersonatedUserId ? { impersonatedUserId: attribution.impersonatedUserId } : {}) },
  }));
  await db.query(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, reason, metadata)
    SELECT $1, action, entity_type, entity_id, reason, metadata
      FROM jsonb_to_recordset($2::jsonb) AS item(action text, entity_type text, entity_id uuid, reason text, metadata jsonb)`,
  [attribution.actorId, JSON.stringify(rows)]);
}

export async function recordChange(db: Queryable, entry: ChangeEntry): Promise<void> {
  const attribution = await resolveAuditAttribution(entry.actorId);
  const metadata: Record<string, unknown> = { ...(entry.extra ?? {}) };
  if (entry.previous !== undefined) metadata.previous = entry.previous;
  if (entry.next !== undefined) metadata.next = entry.next;
  if (attribution.impersonatedUserId) {
    metadata.impersonatedUserId = attribution.impersonatedUserId;
  }

  await db.query(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      attribution.actorId,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.reason ?? null,
      Object.keys(metadata).length ? JSON.stringify(metadata) : null,
    ],
  );
}

/**
 * Compute the changed fields between two shallow records, so an audit entry
 * carries only what actually changed rather than the whole row.
 */
export function diff<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { previous: Partial<T>; next: Partial<T> } {
  const previous: Partial<T> = {};
  const next: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    const a = after[key];
    if (a === undefined) continue;
    if (before[key] !== a) {
      previous[key] = before[key];
      next[key] = a as T[keyof T];
    }
  }
  return { previous, next };
}
