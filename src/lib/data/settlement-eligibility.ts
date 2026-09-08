/**
 * Current due/balance eligibility only. Recorded cash events remain history even
 * when their source subsequently needs review. Callers retain their role scope.
 */
export function settlementCurrentAmountSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("Invalid settlement table alias");
  return `(
    ${alias}.status = 'active'
    AND NOT COALESCE(${alias}.id = ANY((
      SELECT blocked_obligation_ids FROM "settlement_ledger_state" WHERE singleton = true
    )::uuid[]), true)
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
