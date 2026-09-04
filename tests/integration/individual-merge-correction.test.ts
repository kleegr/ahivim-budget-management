import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { decideMatchReview } from "@/lib/manage/individual-merge";
import { reconcileIncorrectIndividualMerge } from "@/lib/manage/individual-merge-correction";
import { createIndividual } from "@/lib/manage/individuals";
import { closeTestPool, hasTestDatabase, resetSchema, testPool } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
const ACTOR = "00000000-0000-4000-8000-000000000001";
let pool: PgLikePool;

function unwrap<T>(result: { ok: true; data: T } | { ok: false; code: string; message: string }): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.data;
}

suite("incorrect individual merge correction (real PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
    pool = testPool();
  }, 60_000);
  afterAll(closeTestPool);

  it("restores only provenance-linked rows and is idempotent", async () => {
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, role)
       VALUES ($1, 'merge-correction@example.test', 'Merge Corrector', 'x', 'admin')
       ON CONFLICT (id) DO NOTHING`,
      [ACTOR],
    );
    const survivor = unwrap(await createIndividual(pool, { displayName: "Sample, Mira" }, ACTOR));
    const folded = unwrap(await createIndividual(pool, { displayName: "Sample, Miri" }, ACTOR));

    const file = await pool.query<{ id: string }>(
      `INSERT INTO imported_files (original_filename, byte_size, checksum_sha256, template_detected)
       VALUES ('merge-correction.xlsx', 1, 'merge-correction-checksum', 'test')
       RETURNING id`,
    );
    const batch = await pool.query<{ id: string }>(
      `INSERT INTO import_batches (imported_file_id, status, total_rows, valid_rows, imported_rows)
       VALUES ($1, 'committed', 2, 2, 2)
       RETURNING id`,
      [file.rows[0]!.id],
    );

    const miriImport = await pool.query<{ id: string }>(
      `INSERT INTO import_rows
         (import_batch_id, sheet_name, source_row_number, raw_values, status,
          resolved_individual_id, transaction_fingerprint)
       VALUES ($1, 'Payroll', 1555, $2::jsonb, 'valid', $3, 'miri-evidence-fp')
       RETURNING id`,
      [batch.rows[0]!.id, JSON.stringify({ individual: "Sample, Miri" }), folded.id],
    );
    const miriTx = await pool.query<{ id: string }>(
      `INSERT INTO payroll_transactions
         (import_batch_id, import_row_id, source_file_id, source_row_number,
          individual_id, individual_raw, imported_hours, imported_amount, transaction_fingerprint)
       VALUES ($1, $2, $3, 1555, $4, 'Sample, Miri', 10, 200, 'miri-evidence-fp')
       RETURNING id`,
      [batch.rows[0]!.id, miriImport.rows[0]!.id, file.rows[0]!.id, folded.id],
    );
    const session = await pool.query<{ id: string }>(
      `INSERT INTO service_sessions (import_batch_id, physical_hours, group_size, group_detection_status)
       VALUES ($1, 10, 1, 'single')
       RETURNING id`,
      [batch.rows[0]!.id],
    );
    const allocation = await pool.query<{ id: string }>(
      `INSERT INTO service_allocations
         (service_session_id, individual_id, payroll_transaction_id,
          allocation_hours, allocated_rate, allocated_amount)
       VALUES ($1, $2, $3, 10, 20, 200)
       RETURNING id`,
      [session.rows[0]!.id, folded.id, miriTx.rows[0]!.id],
    );
    const warnings = await pool.query<{ id: string }>(
      `INSERT INTO import_warnings
         (import_batch_id, import_row_id, individual_id, category, message)
       VALUES ($1, $2, $3, 'test_one', 'first warning'),
              ($1, $2, $3, 'test_two', 'second warning')
       RETURNING id`,
      [batch.rows[0]!.id, miriImport.rows[0]!.id, folded.id],
    );

    const miraImport = await pool.query<{ id: string }>(
      `INSERT INTO import_rows
         (import_batch_id, sheet_name, source_row_number, raw_values, status,
          resolved_individual_id, transaction_fingerprint)
       VALUES ($1, 'Payroll', 2000, $2::jsonb, 'valid', $3, 'mira-own-fp')
       RETURNING id`,
      [batch.rows[0]!.id, JSON.stringify({ individual: "Sample, Mira" }), survivor.id],
    );
    const miraTx = await pool.query<{ id: string }>(
      `INSERT INTO payroll_transactions
         (import_batch_id, import_row_id, source_file_id, source_row_number,
          individual_id, individual_raw, imported_hours, imported_amount, transaction_fingerprint)
       VALUES ($1, $2, $3, 2000, $4, 'Sample, Mira', 5, 100, 'mira-own-fp')
       RETURNING id`,
      [batch.rows[0]!.id, miraImport.rows[0]!.id, file.rows[0]!.id, survivor.id],
    );

    const review = await pool.query<{ id: string }>(
      `INSERT INTO individual_match_reviews
         (keep_individual_id, merge_individual_id, score, reason, status)
       VALUES ($1, $2, 0.9, 'Names are 90% similar overall.', 'pending')
       RETURNING id`,
      [survivor.id, folded.id],
    );
    unwrap(await decideMatchReview(
      pool,
      { id: review.rows[0]!.id, decision: "confirm" },
      ACTOR,
      "Confirmed match",
    ));

    const mergeAudit = await pool.query<{ id: string }>(
      `SELECT id
         FROM audit_logs
        WHERE action = 'individuals_merged'
          AND entity_id = $1
          AND metadata->>'mergedId' = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [survivor.id, folded.id],
    );
    const input = {
      mergeAuditLogId: mergeAudit.rows[0]!.id,
      foldedId: folded.id,
      survivorId: survivor.id,
      expectedFoldedName: "Sample, Miri",
      expectedSurvivorName: "Sample, Mira",
      evidenceSourceName: "Sample, Miri",
      reason: "Source workbook and immutable import rows prove these are distinct people.",
    };

    const wrongEvidence = await reconcileIncorrectIndividualMerge(pool, {
      ...input,
      evidenceSourceName: "Sample, Mira",
    });
    expect(wrongEvidence.outcome).toBe("blocked");
    expect(wrongEvidence.blocks).toEqual(expect.arrayContaining([
      expect.stringContaining("does not normalize to the folded individual's canonical name"),
    ]));

    const dryRun = await reconcileIncorrectIndividualMerge(pool, input);
    expect(dryRun).toMatchObject({
      mode: "dry-run",
      outcome: "ready",
      eligible: true,
      evidence: {
        transactionCount: 1,
        allocationCount: 1,
        warningCount: 2,
        importRowCount: 1,
        sourceRows: [1555],
      },
      actions: {
        restoreTransactions: 1,
        restoreAllocations: 1,
        restoreWarnings: 2,
        archiveMergeAlias: true,
        rejectMergeReview: true,
      },
      blocks: [],
    });
    expect((await pool.query<{ individual_id: string }>(
      `SELECT individual_id FROM payroll_transactions WHERE id = $1`,
      [miriTx.rows[0]!.id],
    )).rows[0]!.individual_id).toBe(survivor.id);

    const applied = await reconcileIncorrectIndividualMerge(pool, input, { apply: true, actorId: ACTOR });
    expect(applied.outcome).toBe("applied");
    expect(applied.correctionAuditLogId).toBeTruthy();
    expect((await pool.query<{ status: string; merged_into_id: string | null; archived_at: string | null }>(
      `SELECT status, merged_into_id, archived_at::text FROM individuals WHERE id = $1`,
      [folded.id],
    )).rows[0]).toEqual({ status: "active", merged_into_id: null, archived_at: null });
    expect((await pool.query<{ individual_id: string }>(
      `SELECT individual_id FROM payroll_transactions WHERE id = $1`,
      [miriTx.rows[0]!.id],
    )).rows[0]!.individual_id).toBe(folded.id);
    expect((await pool.query<{ individual_id: string }>(
      `SELECT individual_id FROM payroll_transactions WHERE id = $1`,
      [miraTx.rows[0]!.id],
    )).rows[0]!.individual_id).toBe(survivor.id);
    expect((await pool.query<{ individual_id: string }>(
      `SELECT individual_id FROM service_allocations WHERE id = $1`,
      [allocation.rows[0]!.id],
    )).rows[0]!.individual_id).toBe(folded.id);
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM import_warnings
        WHERE id = ANY($1::uuid[]) AND individual_id = $2`,
      [warnings.rows.map((row) => row.id), folded.id],
    )).rows[0]!.count).toBe("2");
    expect((await pool.query<{ resolved_individual_id: string }>(
      `SELECT resolved_individual_id FROM import_rows WHERE id = $1`,
      [miriImport.rows[0]!.id],
    )).rows[0]!.resolved_individual_id).toBe(folded.id);
    expect((await pool.query<{ status: string }>(
      `SELECT status FROM individual_aliases WHERE normalized_alias = 'miri sample'`,
    )).rows[0]!.status).toBe("archived");
    expect((await pool.query<{ status: string }>(
      `SELECT status FROM individual_match_reviews WHERE id = $1`,
      [review.rows[0]!.id],
    )).rows[0]!.status).toBe("rejected");

    const second = await reconcileIncorrectIndividualMerge(pool, input, { apply: true, actorId: ACTOR });
    expect(second.outcome).toBe("already-applied");
    expect(second.correctionAuditLogId).toBe(applied.correctionAuditLogId);
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_logs
        WHERE action = 'individual_merge_correction_applied'
          AND metadata->>'mergeAuditLogId' = $1`,
      [input.mergeAuditLogId],
    )).rows[0]!.count).toBe("1");
  });
});
