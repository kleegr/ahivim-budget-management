import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { recordChange } from "./audit";
import { fail, ok, type Result } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function rollback(client: PgLikeClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original operation result is more useful than a rollback failure.
  }
}

/** Accept the imported rate as a deliberate source fact without changing money. */
export async function acceptImportedRate(
  pool: PgLikePool,
  exceptionId: string,
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string; alreadyAccepted: boolean }>> {
  if (!UUID.test(exceptionId)) return fail("not_found", "That rate exception no longer exists.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      id: string;
      resolution: string;
      payroll_transaction_id: string | null;
      imported_rate: string;
      expected_rate: string;
    }>(
      `SELECT id, resolution, payroll_transaction_id,
              imported_rate::text, expected_rate::text
         FROM rate_exceptions
        WHERE id = $1
        FOR UPDATE`,
      [exceptionId],
    );
    const exception = rows[0];
    if (!exception) {
      await rollback(client);
      return fail("not_found", "That rate exception no longer exists.");
    }
    if (!exception.payroll_transaction_id) {
      await rollback(client);
      return fail("conflict", "This exception has no committed transaction, so its rate cannot be accepted.");
    }
    if (exception.resolution === "accepted") {
      await client.query("COMMIT");
      return ok({ id: exceptionId, alreadyAccepted: true });
    }
    if (exception.resolution !== "open") {
      await rollback(client);
      return fail("conflict", "This rate exception was already resolved another way.");
    }

    await client.query(
      `UPDATE rate_exceptions SET resolution = 'accepted', updated_at = now() WHERE id = $1`,
      [exceptionId],
    );
    await recordChange(client, {
      actorId,
      action: "rate_exception.accepted",
      entityType: "rate_exception",
      entityId: exceptionId,
      previous: { resolution: exception.resolution },
      next: {
        resolution: "accepted",
        transactionId: exception.payroll_transaction_id,
        importedRate: exception.imported_rate,
        expectedRate: exception.expected_rate,
      },
      reason: reason ?? "Confirmed as a legitimate imported rate",
      extra: { transactionAmountsChanged: false },
    });
    await client.query("COMMIT");
    return ok({ id: exceptionId, alreadyAccepted: false });
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}
