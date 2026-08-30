import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { fail, ok, type Result } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function rollback(client: PgLikeClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original operation result if rollback itself fails.
  }
}

/** Mark a committed duplicate warning reviewed without changing its ledger row. */
export async function reviewCommittedDuplicateWarning(
  pool: PgLikePool,
  warningId: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string; transactionId: string; alreadyReviewed: boolean }>> {
  if (!UUID.test(warningId)) return fail("not_found", "That duplicate warning no longer exists.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      id: string;
      resolved_at: string | null;
      row_status: string;
      transaction_id: string | null;
    }>(
      `SELECT w.id, w.resolved_at::text AS resolved_at, r.status AS row_status,
              tx.id AS transaction_id
         FROM import_warnings w
         JOIN import_rows r ON r.id = w.import_row_id
         LEFT JOIN LATERAL (
           SELECT candidate.id
             FROM payroll_transactions candidate
            WHERE candidate.import_row_id = r.id
            ORDER BY candidate.created_at DESC, candidate.id DESC
            LIMIT 1
         ) tx ON true
        WHERE w.id = $1
          AND w.category = 'possible_duplicate'
        FOR UPDATE OF w`,
      [warningId],
    );
    const warning = rows[0];
    if (!warning) {
      await rollback(client);
      return fail("not_found", "That duplicate warning no longer exists.");
    }
    if (warning.resolved_at) {
      if (!warning.transaction_id) {
        await rollback(client);
        return fail("conflict", "The committed transaction for this warning is missing.");
      }
      await client.query("COMMIT");
      return ok({ id: warning.id, transactionId: warning.transaction_id, alreadyReviewed: true });
    }
    if (warning.row_status !== "imported") {
      await rollback(client);
      return fail("conflict", "This source row is no longer a committed duplicate candidate.");
    }
    if (!warning.transaction_id) {
      await rollback(client);
      return fail("conflict", "The committed transaction for this warning is missing.");
    }

    await client.query(
      `UPDATE import_warnings
          SET resolved_at = now(), resolved_by_user_id = $2, updated_at = now()
        WHERE id = $1 AND resolved_at IS NULL`,
      [warning.id, actorId],
    );
    await recordChange(client, {
      actorId,
      action: "import_warning.reviewed",
      entityType: "import_warning",
      entityId: warning.id,
      previous: { resolved: false },
      next: { resolved: true, transactionId: warning.transaction_id },
      reason: reason ?? "Committed duplicate candidate reviewed",
      extra: { ledgerTransactionChanged: false },
    });
    await client.query("COMMIT");
    return ok({ id: warning.id, transactionId: warning.transaction_id, alreadyReviewed: false });
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}
