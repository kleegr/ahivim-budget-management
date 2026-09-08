function assertAlias(alias: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("Invalid settlement table alias");
}

/** These historical explanation rows do not establish an approved final amount. */
export function settlementLegacyIndividualKindSql(alias: string): string {
  assertAlias(alias);
  return `${alias}.kind ~ '^individual_(cut_1|cut_2|clock|other)(_correction)*$'`;
}

/** A calculation divisor does not approve conversion of a monthly final to a period balance. */
export function settlementAmountBasisReviewSql(alias: string): string {
  assertAlias(alias);
  return `(
    ${alias}.kind ~ '^individual_masser(_correction)*$'
    AND (
      (
        NOT EXISTS (
          SELECT 1 FROM settlement_obligations basis_parent
           WHERE basis_parent.id::text = ${alias}.calculation_metadata->>'adjustmentForObligationId'
             AND basis_parent.id <> ${alias}.id
             AND basis_parent.individual_id = ${alias}.individual_id
        )
        AND NOT (
          ${alias}.original_amount = 0
          OR (
          -- Today's setup cannot approve an existing snapshot's amount basis.
          -- Keep an explicitly recorded single-month final usable, with its
          -- same-person source, even when that source is now archived.
          COALESCE(CASE
            WHEN ${alias}.calculation_metadata->>'monthDivisor' ~ '^[0-9]+([.][0-9]+)?$'
            THEN (${alias}.calculation_metadata->>'monthDivisor')::numeric = 1
            ELSE false END, false)
          AND COALESCE(CASE
            WHEN ${alias}.calculation_metadata->>'monthlyAmount' ~ '^-?[0-9]+([.][0-9]+)?$'
            THEN abs((${alias}.calculation_metadata->>'monthlyAmount')::numeric) = ${alias}.original_amount
            ELSE false END, false)
          AND EXISTS (
            SELECT 1 FROM calculation_strategies historical_source
             WHERE historical_source.id = ${alias}.calculation_strategy_id
               AND historical_source.individual_id = ${alias}.individual_id
          )
          )
        )
      )
      OR (
        COALESCE(${alias}.period_end, 'infinity'::date) > (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date
        AND EXISTS (
          SELECT 1 FROM calculation_strategies basis_source
           WHERE basis_source.id = ${alias}.calculation_strategy_id
             AND basis_source.individual_id = ${alias}.individual_id
             AND basis_source.status = 'active'
             AND basis_source.after_all <> 0
             AND basis_source.month_divisor <> 1
        )
      )
    )
  )`;
}

/** Read original provenance without treating a prior persisted hold as new evidence. */
export function settlementIndividualSourceReviewSql(alias: string): string {
  assertAlias(alias);
  return `EXISTS (
      WITH RECURSIVE source_ancestors AS (
        SELECT ${alias}.id, ${alias}.kind, ${alias}.calculation_metadata,
               ${alias}.period_end, ${alias}.calculation_strategy_id, ${alias}.individual_id, ${alias}.original_amount
        UNION
        SELECT parent.id, parent.kind, parent.calculation_metadata,
               parent.period_end, parent.calculation_strategy_id, parent.individual_id, parent.original_amount
          FROM settlement_obligations parent
          JOIN source_ancestors child
            ON parent.id::text = child.calculation_metadata->>'adjustmentForObligationId'
      )
      SELECT 1 FROM source_ancestors ancestor
       WHERE ${settlementLegacyIndividualKindSql("ancestor")}
          OR ${settlementAmountBasisReviewSql("ancestor")}
          OR (
            ${alias}.kind ~ '^individual_masser(_correction)*$'
            AND NOT EXISTS (
              SELECT 1 FROM source_ancestors terminal_source
               WHERE NOT EXISTS (
                 SELECT 1 FROM settlement_obligations terminal_parent
                  WHERE terminal_parent.id::text = terminal_source.calculation_metadata->>'adjustmentForObligationId'
                    AND terminal_parent.id <> terminal_source.id
                    AND terminal_parent.individual_id = terminal_source.individual_id
               )
            )
          )
    )`;
}

/** Also protect descendants before a refresh has populated persisted holds. */
export function settlementSourceReviewSql(alias: string): string {
  assertAlias(alias);
  return `(
    COALESCE(${alias}.id = ANY((
      SELECT blocked_obligation_ids FROM "settlement_ledger_state" WHERE singleton = true
    )::uuid[]), true)
    OR ${settlementIndividualSourceReviewSql(alias)}
  )`;
}

/**
 * Current due/balance eligibility only. Recorded cash events remain history even
 * when their source subsequently needs review. Callers retain their role scope.
 */
export function settlementCurrentAmountSql(alias: string): string {
  assertAlias(alias);
  return `(
    ${alias}.status = 'active'
    AND NOT ${settlementSourceReviewSql(alias)}
    AND (
      (COALESCE(${alias}.calculation_metadata->>'flow', '') <> 'direct_employee'
       AND ${alias}.kind NOT LIKE 'employee_giveback%')
      OR EXISTS (
        SELECT 1 FROM employee_payroll_checks verified_check
         WHERE verified_check.employee_id = ${alias}.employee_id
           AND verified_check.verification_status = 'verified'
           AND (
             verified_check.id::text = ${alias}.calculation_metadata->>'payrollCheckId'
             OR (
               NULLIF(${alias}.calculation_metadata->>'payrollCheckId', '') IS NULL
               AND EXISTS (
                 SELECT 1 FROM settlement_obligation_transactions check_source
                 JOIN payroll_transactions source_transaction
                   ON source_transaction.id = check_source.payroll_transaction_id
                  AND source_transaction.employee_id = ${alias}.employee_id
                 WHERE check_source.settlement_obligation_id = ${alias}.id
                   AND source_transaction.payroll_check_id = verified_check.id
               )
             )
           )
      )
    )
  )`;
}
