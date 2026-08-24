const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

/**
 * Keep the rate-review queue tied to real, single-person ledger rows.
 * Group pricing is reviewed at the service-session level instead of being
 * repeated once per member, and duplicate imports without a committed
 * transaction never become actionable exceptions.
 */
export function actionableRateExceptionSource(alias = "x"): string {
  if (!SQL_IDENTIFIER.test(alias)) throw new Error("Invalid SQL alias.");
  return `${alias}.payroll_transaction_id IN (
    SELECT rate_tx.id
      FROM payroll_transactions rate_tx
      LEFT JOIN service_sessions rate_session ON rate_session.id = rate_tx.service_session_id
     WHERE rate_session.id IS NULL
        OR rate_session.group_size = 1
        OR rate_session.group_detection_status = 'single'
  )`;
}
