import { createHash, randomUUID } from "node:crypto";
import type { PgLikePool } from "@/lib/import/commit";
import { ok, fail, type Result } from "@/lib/manage/errors";
import { recordChange, recordChanges } from "@/lib/manage/audit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type PaidState = { id: string; is_paid: boolean; paid_at: string | null; paid_note: string | null };

/** Application-owned payout tracking only; never writes the connected Sheet. */
export async function setTransactionsPaid(
  pool: PgLikePool,
  input: { ids: string[]; paid: boolean; note?: string | null; reason?: string | null; batchId?: string },
  actorId: string | null,
): Promise<Result<{ updated: number; batchId: string }>> {
  if (!Array.isArray(input.ids) || input.ids.some(id => typeof id !== "string" || !UUID.test(id))) return fail("validation", "Select valid transaction records.");
  const ids = [...new Set(input.ids)].sort();
  if (!ids.length) return fail("validation", "Select at least one transaction.");
  if (ids.length > 20000) return fail("validation", "Too many rows selected at once.");
  if (typeof input.paid !== "boolean") return fail("validation", "Choose Paid or Unpaid.");
  if (input.batchId && !UUID.test(input.batchId)) return fail("validation", "Invalid batch identity.");
  const batchId = input.batchId ?? randomUUID();
  const note = input.note === undefined ? undefined : input.note?.trim() || null;
  const reason = input.reason?.trim() || (input.paid ? "Operator marked Paid" : "Operator marked Unpaid");
  const fingerprint = createHash("sha256").update(JSON.stringify({ ids, paid: input.paid, note, reason, actorId })).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`transaction-paid:${batchId}`]);
    const prior = await client.query<{ metadata: { fingerprint: string; updated: number } }>(
      "SELECT metadata FROM audit_logs WHERE action = 'transaction_paid_batch' AND entity_id = $1 LIMIT 1", [batchId]);
    if (prior.rows[0]) {
      if (prior.rows[0].metadata.fingerprint !== fingerprint) {
        await client.query("ROLLBACK");
        return fail("conflict", "This batch identity already belongs to a different change.");
      }
      await client.query("COMMIT");
      return ok({ updated: prior.rows[0].metadata.updated, batchId });
    }
    const before = await client.query<PaidState>(`SELECT id, is_paid, paid_at::text, paid_note
      FROM payroll_transactions WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ids]);
    if (before.rows.length !== ids.length) {
      await client.query("ROLLBACK");
      return fail("conflict", "Some selected transactions are no longer available. Refresh the selection.");
    }
    const changed = before.rows.filter(row => row.is_paid !== input.paid || (note !== undefined && row.paid_note !== note));
    if (changed.length) {
      const after = await client.query<PaidState>(`UPDATE payroll_transactions SET is_paid = $1,
        paid_at = CASE WHEN is_paid = $1 THEN paid_at WHEN $1 THEN now() ELSE NULL END,
        paid_note = CASE WHEN $2 THEN $3 ELSE paid_note END, updated_at = now()
        WHERE id = ANY($4::uuid[]) RETURNING id, is_paid, paid_at::text, paid_note`,
      [input.paid, note !== undefined, note ?? null, changed.map(row => row.id)]);
      const nextById = new Map(after.rows.map(row => [row.id, row]));
      await recordChanges(client, changed.map(row => ({ actorId,
        action: input.paid ? "transaction_marked_paid" : "transaction_marked_unpaid",
        entityType: "payroll_transaction", entityId: row.id, previous: row, next: nextById.get(row.id), reason,
        extra: { batchId },
      })));
    }
    await recordChange(client, { actorId, action: "transaction_paid_batch", entityType: "transaction_batch", entityId: batchId,
      reason, extra: { fingerprint, updated: changed.length, selected: ids.length, batchId } });
    await client.query("COMMIT");
    return ok({ updated: changed.length, batchId });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
