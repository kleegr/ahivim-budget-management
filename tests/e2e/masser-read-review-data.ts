import type { PgLikePool } from "../../src/lib/import/commit";
import { COLLECTIONS_ACCESS } from "../../src/lib/auth/access-presets";
import { provisionUser } from "../../src/lib/auth/provision-user";
import { LINKED_INDIVIDUAL_ID, PRIMARY_CALCULATION_ACCOUNT, UNLINKED_EMPLOYEE_ID } from "./fixtures";
import {
  MASSER_HIDDEN_CHECK_COUNT, MASSER_REVIEW_CHECK_COUNT, MASSER_REVIEW_COLLECTOR_EMAIL,
  MASSER_REVIEW_COLLECTOR_PASSWORD, MASSER_REVIEW_EMPLOYEE_ID, MASSER_REVIEW_EMPLOYEE_NAME,
  MASSER_REVIEW_OBLIGATION_ID,
} from "./masser-read-review-fixtures";

/** Called only by the guarded disposable seed, before its final real refresh. */
export async function seedMasserReadReviewData(pool: PgLikePool, actorId: string): Promise<void> {
  const source = await pool.query<{ id: string }>(`SELECT id FROM calculation_strategies
    WHERE individual_id = $1 AND account = $2 AND after_all = 175 AND month_divisor = 12`,
  [LINKED_INDIVIDUAL_ID, PRIMARY_CALCULATION_ACCOUNT]);
  if (source.rows.length !== 1) throw new Error("The synthetic monthly plan fixture changed.");
  // Reproduce an imported annual-looking legacy balance without approving that
  // basis. Monthly approvals remain the existing 175 + 85; no cash is invented.
  await pool.query(`INSERT INTO settlement_obligations
    (id, source_key, kind, direction, individual_id, calculation_strategy_id,
     original_amount, period_begin, period_end, calculation_metadata, created_by_user_id)
    VALUES ($1, 'e2e:masser-held-read', 'individual_masser', 'reserve', $2, $3,
      2100, '2026-01-01', '2027-01-01',
      '{"flow":"individual_plan","monthlyAmount":null,"source":"disposable_e2e_legacy_review"}'::jsonb, $4)`,
  [MASSER_REVIEW_OBLIGATION_ID, LINKED_INDIVIDUAL_ID, source.rows[0]!.id, actorId]);
  await pool.query(`INSERT INTO employees (id, display_name, normalized_name)
    VALUES ($1, $2, 'e2e-check-review-employee')`, [MASSER_REVIEW_EMPLOYEE_ID, MASSER_REVIEW_EMPLOYEE_NAME]);
  // These isolated, unverified checks have no payroll links or posted money.
  // Existing employee whole-check facts and financial report amounts stay intact.
  for (const [employeeId, count, prefix] of [
    [MASSER_REVIEW_EMPLOYEE_ID, MASSER_REVIEW_CHECK_COUNT, "visible"],
    [UNLINKED_EMPLOYEE_ID, MASSER_HIDDEN_CHECK_COUNT, "hidden"],
  ] as const) {
    await pool.query(`INSERT INTO employee_payroll_checks
      (employee_id, check_number, actual_gross, actual_net, verification_status, source, source_ref)
      SELECT $1::uuid, 'E2E-REVIEW-' || $3 || '-' || n, 0, 0, 'unverified', 'import', 'disposable_e2e_review'
      FROM generate_series(1, $2::int) n`, [employeeId, count, prefix]);
  }
  const user = await provisionUser(pool, {
    preset: "custom_access", email: MASSER_REVIEW_COLLECTOR_EMAIL,
    displayName: "E2E Scoped Review Collector", password: MASSER_REVIEW_COLLECTOR_PASSWORD,
    internalAccess: { ...COLLECTIONS_ACCESS, seeAllIndividuals: false, seeAllEmployees: false,
      individualIds: [LINKED_INDIVIDUAL_ID], employeeIds: [MASSER_REVIEW_EMPLOYEE_ID] },
    reason: "Disposable direct-grant Masser browser acceptance",
  }, actorId);
  if (!user.ok) throw new Error(`Could not seed scoped review collector: ${user.message}`);
}
