import { transactionScopeClause, type AccessScope } from "@/lib/auth/access";
import type { PgLikePool } from "@/lib/import/commit";
import { listTransactionsForGrid, type GridTransaction } from "@/lib/data/transactions-grid";
import { validSettlementSourceKey } from "@/lib/business/settlement-source-key";

const MAX_SOURCE_TRANSACTIONS = 10_000;

export interface SettlementSourceTransactions {
  transactionIds: string[];
  tooLarge: boolean;
}

export interface SettlementSourceTransactionRows extends SettlementSourceTransactions {
  rows: GridTransaction[];
}

/**
 * Resolve the compact source key produced by Money operations back to its
 * exact transaction rows. The transaction scope is applied inside this query,
 * so a copied or edited link cannot widen the current user's ledger access.
 */
export async function resolveSettlementSourceTransactions(
  pool: PgLikePool,
  scope: AccessScope,
  sourceId: string,
): Promise<SettlementSourceTransactions> {
  if (!validSettlementSourceKey(sourceId)) return { transactionIds: [], tooLarge: false };

  const params: unknown[] = [sourceId];
  const scopeClause = transactionScopeClause(scope, "t.individual_id", "t.employee_id", params);
  const { rows } = await pool.query<{ id: string }>(
    `WITH direct_facts AS (
       SELECT t.id, t.employee_id,
              pc.id AS verified_payroll_check_id,
              CASE WHEN pc.id IS NOT NULL
                THEN NULLIF(btrim(pc.check_number), '')
                ELSE NULLIF(btrim(t.check_number), '')
              END AS check_number,
              CASE WHEN pc.id IS NOT NULL THEN pc.check_date ELSE t.check_date END AS check_date,
              CASE WHEN pc.id IS NOT NULL THEN pc.period_begin ELSE t.period_begin END AS period_begin,
              CASE WHEN pc.id IS NOT NULL THEN pc.period_end ELSE t.period_end END AS period_end
         FROM payroll_transactions t
         LEFT JOIN programs p ON p.id = t.program_id
         LEFT JOIN employee_payroll_checks pc
           ON pc.id = t.payroll_check_id
          AND pc.employee_id = t.employee_id
          AND pc.verification_status = 'verified'
        WHERE t.employee_id IS NOT NULL
          AND effective_payment_recipient(
            t.payment_recipient,
            p.payment_recipient
          ) = 'employee'
          AND (
            pc.id IS NOT NULL
            OR (t.check_number IS NOT NULL AND btrim(t.check_number) <> '')
            OR t.check_date IS NOT NULL OR t.period_begin IS NOT NULL OR t.period_end IS NOT NULL
          )${scopeClause}
     ), direct_sources AS (
       SELECT direct_facts.*,
              CASE
                WHEN verified_payroll_check_id IS NOT NULL
                  THEN concat(employee_id::text, ':payroll-check:', verified_payroll_check_id::text)
                WHEN check_number IS NOT NULL
                  THEN concat(
                    employee_id::text, ':check:', check_number, ':',
                    CASE
                      WHEN check_date IS NOT NULL THEN concat('date:', check_date::text)
                      WHEN period_begin IS NOT NULL OR period_end IS NOT NULL
                        THEN concat('period:', COALESCE(period_begin::text, ''), ':', COALESCE(period_end::text, ''))
                      ELSE 'undated'
                    END
                  )
                ELSE concat(
                  employee_id::text, ':',
                  CASE
                    WHEN period_begin IS NOT NULL OR period_end IS NOT NULL
                      THEN concat('period:', COALESCE(period_begin::text, ''), ':', COALESCE(period_end::text, ''))
                    ELSE concat('date:', check_date::text)
                  END
                )
              END AS source_id
         FROM direct_facts
     ), ambiguous_numbered_checks AS (
       SELECT employee_id, NULLIF(btrim(check_number), '') AS check_number
         FROM direct_sources
        WHERE verified_payroll_check_id IS NULL
          AND check_number IS NOT NULL AND btrim(check_number) <> ''
        GROUP BY employee_id, NULLIF(btrim(check_number), '')
       HAVING count(DISTINCT check_date) > 1
          AND count(*) FILTER (WHERE check_date IS NULL) > 0
     ), resolved AS (
       SELECT id FROM direct_sources WHERE source_id = $1
       UNION
       SELECT source.id
         FROM direct_sources source
         JOIN ambiguous_numbered_checks ambiguous
           ON ambiguous.employee_id = source.employee_id
          AND ambiguous.check_number = NULLIF(btrim(source.check_number), '')
        WHERE concat(
          source.employee_id::text,
          ':ambiguous-check:',
          NULLIF(btrim(source.check_number), '')
        ) = $1
     )
     SELECT id::text AS id
       FROM resolved
      ORDER BY id
      LIMIT ${MAX_SOURCE_TRANSACTIONS + 1}`,
    params,
  );

  return {
    transactionIds: rows.slice(0, MAX_SOURCE_TRANSACTIONS).map((row) => row.id),
    tooLarge: rows.length > MAX_SOURCE_TRANSACTIONS,
  };
}

/**
 * Resolve and load one compact source without ever treating an empty result as
 * an unfiltered ledger request.
 */
export async function listSettlementSourceTransactions(
  pool: PgLikePool,
  scope: AccessScope,
  sourceId: string,
): Promise<SettlementSourceTransactionRows> {
  const source = await resolveSettlementSourceTransactions(pool, scope, sourceId);
  if (source.tooLarge || source.transactionIds.length === 0) {
    return { ...source, rows: [] };
  }
  return {
    ...source,
    rows: await listTransactionsForGrid(pool, scope, {
      transactionIds: source.transactionIds,
      allowLargeTransactionSelection: true,
    }),
  };
}
