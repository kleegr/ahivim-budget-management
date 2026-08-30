import type { PgLikePool } from "@/lib/import/commit";
import { ok, fail, type Result } from "@/lib/manage/errors";
import { recordChange } from "@/lib/manage/audit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mark a set of transactions paid or unpaid (the operator's payout tracking).
 * Works for one row or thousands at once — the Transactions grid uses it both for
 * a single-cell toggle and for "mark the N selected rows paid". Setting paid
 * stamps paid_at = now(); clearing it nulls paid_at. An optional note is written
 * only when provided, so a plain toggle never wipes an existing note.
 */
export async function setTransactionsPaid(
  pool: PgLikePool,
  input: { ids: string[]; paid: boolean; note?: string | null },
  actorId: string | null,
): Promise<Result<{ updated: number }>> {
  const ids = Array.isArray(input.ids) ? input.ids.filter((id) => typeof id === "string" && UUID.test(id)) : [];
  if (ids.length === 0) return fail("validation", "Select at least one transaction.");
  if (ids.length > 20000) return fail("validation", "Too many rows selected at once.");

  const sets = ["is_paid = $1", "paid_at = CASE WHEN $1 THEN now() ELSE NULL END", "updated_at = now()"];
  const params: unknown[] = [input.paid];
  if (input.note !== undefined) {
    params.push(input.note && input.note.trim() ? input.note.trim() : null);
    sets.push(`paid_note = $${params.length}`);
  }
  params.push(ids);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(
      `UPDATE payroll_transactions SET ${sets.join(", ")} WHERE id = ANY($${params.length}::uuid[])`,
      params,
    );

    // A tracked Google-Sheet row keeps the operator's change protected until
    // write-back succeeds. The next pull must not silently replace this value.
    await client.query(
      `UPDATE sheet_sync_rows
          SET identity = COALESCE(identity, '{}'::jsonb) || '{"appPaidDirty":true}'::jsonb,
              updated_at = now()
        WHERE payroll_transaction_id = ANY($1::uuid[])`,
      [ids],
    );

    await recordChange(client, {
      actorId,
      action: input.paid ? "transactions_marked_paid" : "transactions_marked_unpaid",
      entityType: "payroll_transaction",
      entityId: ids.length === 1 ? ids[0] : null,
      extra: { count: rowCount ?? 0 },
    });
    await client.query("COMMIT");
    return ok({ updated: rowCount ?? 0 });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
