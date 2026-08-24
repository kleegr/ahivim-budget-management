import type { PgLikeClient } from "@/lib/import/commit";
import { acquireSettlementSourceLock } from "@/lib/manage/settlement-freshness";

type SettlementPersonType = "employee" | "individual";

/**
 * Repoint the two settlement identity tables in an order that keeps every
 * event aligned with its obligation throughout a person merge.
 */
export async function repointSettlementPerson(
  client: PgLikeClient,
  personType: SettlementPersonType,
  keepId: string,
  mergeId: string,
): Promise<Record<string, number>> {
  const column = personType === "employee" ? "employee_id" : "individual_id";

  // Payment actions take this lock before obligation row locks. Keep the same
  // order here; later payroll updates in the merge re-enter it through the
  // database dirty-state trigger.
  await acquireSettlementSourceLock(client);

  await client.query(
    `SELECT id
       FROM settlement_obligations
      WHERE "${column}" = ANY($1::uuid[])
      ORDER BY id
      FOR UPDATE`,
    [[keepId, mergeId]],
  );

  const obligations = await client.query(
    `UPDATE settlement_obligations
        SET "${column}" = $1, updated_at = now()
      WHERE "${column}" = $2`,
    [keepId, mergeId],
  );
  const events = await client.query(
    `UPDATE settlement_events
        SET "${column}" = $1
      WHERE "${column}" = $2`,
    [keepId, mergeId],
  );

  return {
    ...(obligations.rowCount ? { settlement_obligations: obligations.rowCount } : {}),
    ...(events.rowCount ? { settlement_events: events.rowCount } : {}),
  };
}
