import type { PgLikePool } from "@/lib/import/commit";

export interface SourceNetRecoveryHistory {
  acceptanceAuditId: string;
  conflictId: string;
  transactionId: string;
  acceptedNet: string;
  acceptedAt: string;
  acceptedBy: string | null;
  reason: string | null;
  reversedAt: string | null;
  reversalAuditId: string | null;
}

/** Manager-only callers must authorize before reading source amounts or history. */
export async function listSourceNetRecoveryHistory(pool: PgLikePool): Promise<SourceNetRecoveryHistory[]> {
  const { rows } = await pool.query<SourceNetRecoveryHistory>(`
    SELECT a.id AS "acceptanceAuditId", a.metadata->>'conflictId' AS "conflictId",
           a.entity_id::text AS "transactionId", a.metadata->>'acceptedNet' AS "acceptedNet",
           a.created_at::text AS "acceptedAt", u.display_name AS "acceptedBy", a.reason,
           r.created_at::text AS "reversedAt", r.id AS "reversalAuditId"
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.user_id
      LEFT JOIN audit_logs r ON r.action = 'source_net_recovery_reversed'
        AND r.metadata->>'acceptanceAuditId' = a.id::text
     WHERE a.action = 'source_net_recovery_accepted' AND a.entity_type = 'payroll_transaction'
     ORDER BY a.created_at DESC, a.id DESC LIMIT 200`);
  return rows;
}
