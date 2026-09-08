import type { PgLikeClient } from "@/lib/import/commit";
import { settlementIndividualSourceReviewSql, settlementLegacyIndividualKindSql } from "@/lib/data/settlement-eligibility";

/** Include legacy source keys that do not match the currently generated target key. */
export async function amountBasisReviewSourceKeys(
  client: PgLikeClient,
  individualId?: string | null,
): Promise<string[]> {
  const { rows } = await client.query<{ source_key: string }>(
    `SELECT o.source_key FROM settlement_obligations o
      WHERE o.status = 'active' AND o.kind ~ '^individual_masser(_correction)*$'
        AND ${settlementIndividualSourceReviewSql("o")}
        AND ($1::uuid IS NULL OR o.individual_id = $1)
      ORDER BY o.source_key`,
    [individualId ?? null],
  );
  return rows.map((row) => row.source_key);
}

/** Preserve legacy cuts/give-back facts pending evidence, including ended periods. */
export async function legacyIndividualReviewSourceKeys(
  client: PgLikeClient,
  individualId?: string | null,
): Promise<string[]> {
  const { rows } = await client.query<{ source_key: string }>(
    `SELECT o.source_key FROM settlement_obligations o
      WHERE o.status = 'active' AND ${settlementLegacyIndividualKindSql("o")}
        AND ($1::uuid IS NULL OR o.individual_id = $1)
      ORDER BY o.source_key`,
    [individualId ?? null],
  );
  return rows.map((row) => row.source_key);
}

/** Resolve review holds without changing immutable obligations or their source links. */
export async function settlementReviewHolds(
  client: PgLikeClient,
  input: { transactionIds: string[]; strategyIds: string[]; sourceKeys: string[] },
): Promise<Array<{ id: string; source_key: string }>> {
  if (!input.transactionIds.length && !input.strategyIds.length && !input.sourceKeys.length) return [];
  const { rows } = await client.query<{ id: string; source_key: string }>(
    `WITH RECURSIVE unresolved_transactions AS (
       SELECT id, employee_id, payroll_check_id FROM payroll_transactions WHERE id = ANY($1::uuid[])
     ), unresolved_strategies AS (
       SELECT id, individual_id FROM calculation_strategies WHERE id = ANY($2::uuid[])
     ), review_holds AS (
       SELECT o.id, o.source_key
         FROM settlement_obligations o
        WHERE o.status = 'active' AND (
          o.source_key = ANY($3::text[])
          OR o.calculation_strategy_id = ANY($2::uuid[])
          OR EXISTS (
            SELECT 1 FROM settlement_obligation_transactions source
             WHERE source.settlement_obligation_id = o.id
               AND source.payroll_transaction_id = ANY($1::uuid[])
          )
          OR COALESCE(o.calculation_metadata->'sourceTransactionIds', '[]'::jsonb) ?| $1::text[]
          OR o.calculation_metadata->>'payrollCheckId' IN (
            SELECT payroll_check_id::text FROM unresolved_transactions WHERE payroll_check_id IS NOT NULL
          )
          -- Legacy snapshots with no usable provenance cannot be certified from
          -- a different person's facts. Hold that affected person's snapshot.
          OR (
            o.employee_id IN (SELECT employee_id FROM unresolved_transactions)
            AND NOT EXISTS (
              SELECT 1 FROM settlement_obligation_transactions source
              JOIN payroll_transactions linked_source ON linked_source.id = source.payroll_transaction_id
               WHERE source.settlement_obligation_id = o.id
                 AND linked_source.employee_id = o.employee_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM payroll_transactions source
               WHERE source.employee_id = o.employee_id
                 AND (COALESCE(o.calculation_metadata->'sourceTransactionIds', '[]'::jsonb) ? source.id::text
                   OR source.payroll_check_id::text = o.calculation_metadata->>'payrollCheckId')
            )
          )
          OR (
            o.individual_id IN (SELECT individual_id FROM unresolved_strategies)
            AND o.calculation_strategy_id IS NULL
          )
        )
       UNION
       SELECT correction.id, correction.source_key
         FROM settlement_obligations correction
         JOIN review_holds parent
           ON correction.calculation_metadata->>'adjustmentForObligationId' = parent.id::text
        WHERE correction.status = 'active'
     )
     SELECT DISTINCT id, source_key FROM review_holds`,
    [input.transactionIds, input.strategyIds, input.sourceKeys],
  );
  return rows;
}
