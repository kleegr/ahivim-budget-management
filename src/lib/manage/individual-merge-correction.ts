import { createHash } from "node:crypto";
import { normalizePersonName } from "@/lib/business/name-matching";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { recordChange } from "@/lib/manage/audit";
import { acquireSettlementSourceLock } from "@/lib/manage/settlement-freshness";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRECTION_ACTION = "individual_merge_correction_applied";
const EXPECTED_TABLES = ["payroll_transactions", "service_allocations", "import_warnings"] as const;

type Queryable = Pick<PgLikePool, "query"> | Pick<PgLikeClient, "query">;

export interface IndividualMergeCorrectionInput {
  mergeAuditLogId: string;
  foldedId: string;
  survivorId: string;
  expectedFoldedName: string;
  expectedSurvivorName: string;
  /** Exact source spelling whose immutable import resolution identifies the folded person. */
  evidenceSourceName: string;
  reason: string;
}

export interface IndividualMergeCorrectionReport {
  mode: "dry-run" | "apply";
  outcome: "ready" | "blocked" | "applied" | "already-applied";
  eligible: boolean;
  merge: {
    auditLogId: string;
    foldedId: string;
    foldedName: string;
    survivorId: string;
    survivorName: string;
    originalReason: string | null;
    originalActorId: string | null;
    originalCreatedAt: string | null;
  };
  evidence: {
    sourceName: string;
    sourceRows: number[];
    transactionCount: number;
    allocationCount: number;
    warningCount: number;
    importRowCount: number;
    provenanceDigestSha256: string | null;
  };
  actions: {
    restoreFoldedIndividual: boolean;
    restoreTransactions: number;
    restoreAllocations: number;
    restoreWarnings: number;
    archiveMergeAlias: boolean;
    rejectMergeReview: boolean;
  };
  correctionAuditLogId: string | null;
  blocks: string[];
}

interface IndividualRow {
  id: string;
  display_name: string;
  normalized_name: string;
  legal_name: string | null;
  status: string;
  archived_at: string | null;
  merged_into_id: string | null;
}

interface AuditRow {
  id: string;
  user_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  reason: string | null;
  metadata: unknown;
  created_at: string;
}

interface TransactionEvidenceRow {
  id: string;
  import_row_id: string;
  individual_id: string;
  individual_raw: string | null;
  source_row_number: number | null;
  import_source_row_number: number;
  resolved_individual_id: string | null;
}

interface AllocationEvidenceRow {
  id: string;
  individual_id: string;
  payroll_transaction_id: string;
  service_session_id: string;
}

interface WarningEvidenceRow {
  id: string;
  individual_id: string | null;
  import_row_id: string | null;
}

interface AliasRow {
  id: string;
  individual_id: string;
  normalized_alias: string;
  source_text: string;
  status: string;
  created_at: string;
  approved_at: string | null;
  approved_by_user_id: string | null;
  merge_created: boolean;
}

interface ReviewRow {
  id: string;
  keep_individual_id: string;
  merge_individual_id: string;
  status: string;
  reason: string | null;
  decided_by_user_id: string | null;
  decided_at: string | null;
}

interface CorrectionPlan {
  report: IndividualMergeCorrectionReport;
  transactionIds: string[];
  importRowIds: string[];
  allocationIds: string[];
  warningIds: string[];
  aliasId: string | null;
  reviewId: string | null;
  aliasBefore: AliasRow | null;
  reviewBefore: ReviewRow | null;
  foldedBefore: IndividualRow | null;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function exactCount(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function provenanceDigest(parts: Record<string, readonly string[]>): string {
  const canonical = Object.fromEntries(
    Object.entries(parts).sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, uniqueSorted(values)]),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function validateInput(input: IndividualMergeCorrectionInput): void {
  for (const [field, value] of [
    ["mergeAuditLogId", input.mergeAuditLogId],
    ["foldedId", input.foldedId],
    ["survivorId", input.survivorId],
  ] as const) {
    if (!UUID.test(value)) throw new Error(`${field} must be a UUID.`);
  }
  if (input.foldedId === input.survivorId) throw new Error("Folded and survivor IDs must be different.");
  if (!input.expectedFoldedName.trim()) throw new Error("expectedFoldedName is required.");
  if (!input.expectedSurvivorName.trim()) throw new Error("expectedSurvivorName is required.");
  if (!normalizePersonName(input.evidenceSourceName)) throw new Error("evidenceSourceName is required.");
  if (input.reason.trim().length < 8) throw new Error("A specific correction reason is required.");
}

function blankReport(
  input: IndividualMergeCorrectionInput,
  mode: "dry-run" | "apply",
): IndividualMergeCorrectionReport {
  return {
    mode,
    outcome: "blocked",
    eligible: false,
    merge: {
      auditLogId: input.mergeAuditLogId,
      foldedId: input.foldedId,
      foldedName: input.expectedFoldedName,
      survivorId: input.survivorId,
      survivorName: input.expectedSurvivorName,
      originalReason: null,
      originalActorId: null,
      originalCreatedAt: null,
    },
    evidence: {
      sourceName: input.evidenceSourceName,
      sourceRows: [],
      transactionCount: 0,
      allocationCount: 0,
      warningCount: 0,
      importRowCount: 0,
      provenanceDigestSha256: null,
    },
    actions: {
      restoreFoldedIndividual: false,
      restoreTransactions: 0,
      restoreAllocations: 0,
      restoreWarnings: 0,
      archiveMergeAlias: false,
      rejectMergeReview: false,
    },
    correctionAuditLogId: null,
    blocks: [],
  };
}

async function existingCorrection(
  db: Queryable,
  input: IndividualMergeCorrectionInput,
  mode: "dry-run" | "apply",
): Promise<IndividualMergeCorrectionReport | null> {
  const { rows } = await db.query<{ id: string; metadata: unknown }>(
    `SELECT id, metadata
       FROM audit_logs
      WHERE action = $1
        AND metadata->>'mergeAuditLogId' = $2
        AND metadata->>'foldedId' = $3
        AND metadata->>'survivorId' = $4
      ORDER BY created_at
      LIMIT 1`,
    [CORRECTION_ACTION, input.mergeAuditLogId, input.foldedId, input.survivorId],
  );
  const correction = rows[0];
  if (!correction) return null;
  const metadata = objectValue(correction.metadata);
  const restored = objectValue(metadata.restored);
  const report = blankReport(input, mode);
  report.outcome = "already-applied";
  report.correctionAuditLogId = correction.id;
  report.evidence.transactionCount = exactCount(restored.payrollTransactions) ?? 0;
  report.evidence.allocationCount = exactCount(restored.serviceAllocations) ?? 0;
  report.evidence.warningCount = exactCount(restored.importWarnings) ?? 0;
  report.evidence.importRowCount = exactCount(restored.importRows) ?? 0;
  report.evidence.provenanceDigestSha256 = typeof metadata.provenanceDigestSha256 === "string"
    ? metadata.provenanceDigestSha256
    : null;
  return report;
}

async function buildPlan(
  db: Queryable,
  input: IndividualMergeCorrectionInput,
  mode: "dry-run" | "apply",
  lockRows: boolean,
): Promise<CorrectionPlan> {
  const alreadyApplied = await existingCorrection(db, input, mode);
  if (alreadyApplied) {
    return {
      report: alreadyApplied,
      transactionIds: [],
      importRowIds: [],
      allocationIds: [],
      warningIds: [],
      aliasId: null,
      reviewId: null,
      aliasBefore: null,
      reviewBefore: null,
      foldedBefore: null,
    };
  }

  const report = blankReport(input, mode);
  const blocks = report.blocks;
  const lock = lockRows ? " FOR UPDATE" : "";

  const people = await db.query<IndividualRow>(
    `SELECT id, display_name, normalized_name, legal_name, status,
            archived_at::text, merged_into_id
       FROM individuals
      WHERE id = ANY($1::uuid[])${lock}`,
    [[input.foldedId, input.survivorId]],
  );
  const folded = people.rows.find((row) => row.id === input.foldedId) ?? null;
  const survivor = people.rows.find((row) => row.id === input.survivorId) ?? null;
  if (!folded) blocks.push("The folded individual does not exist.");
  if (!survivor) blocks.push("The survivor individual does not exist.");
  if (folded?.display_name !== input.expectedFoldedName) {
    blocks.push("The folded individual's display name does not match the confirmed correction input.");
  }
  if (survivor?.display_name !== input.expectedSurvivorName) {
    blocks.push("The survivor individual's display name does not match the confirmed correction input.");
  }
  if (folded && (folded.status !== "archived" || folded.archived_at === null || folded.merged_into_id !== input.survivorId)) {
    blocks.push("The folded individual is not in the exact archived-into-survivor state expected from this merge.");
  }
  if (survivor && (survivor.status === "archived" || survivor.archived_at !== null || survivor.merged_into_id !== null)) {
    blocks.push("The survivor is not an active, unmerged individual.");
  }
  if (folded && normalizePersonName(input.evidenceSourceName) !== folded.normalized_name) {
    blocks.push("The source-evidence spelling does not normalize to the folded individual's canonical name.");
  }
  if (folded && survivor && folded.normalized_name === survivor.normalized_name) {
    blocks.push("The correction cannot split two rows with the same normalized canonical name.");
  }

  const auditResult = await db.query<AuditRow>(
    `SELECT id, user_id, action, entity_type, entity_id, reason, metadata, created_at::text
       FROM audit_logs
      WHERE id = $1`,
    [input.mergeAuditLogId],
  );
  const audit = auditResult.rows[0] ?? null;
  const auditMetadata = objectValue(audit?.metadata);
  const repointed = objectValue(auditMetadata.repointed);
  report.merge.originalReason = audit?.reason ?? null;
  report.merge.originalActorId = audit?.user_id ?? null;
  report.merge.originalCreatedAt = audit?.created_at ?? null;
  if (!audit) {
    blocks.push("The specified merge audit log does not exist.");
  } else {
    if (audit.action !== "individuals_merged" || audit.entity_type !== "individual" || audit.entity_id !== input.survivorId) {
      blocks.push("The specified audit row is not the exact individuals_merged event for this survivor.");
    }
    if (auditMetadata.mergedId !== input.foldedId || auditMetadata.mergedName !== input.expectedFoldedName) {
      blocks.push("The merge audit metadata does not identify the expected folded individual and name.");
    }
  }

  const expected = Object.fromEntries(EXPECTED_TABLES.map((table) => [table, exactCount(repointed[table])])) as Record<(typeof EXPECTED_TABLES)[number], number | null>;
  for (const table of EXPECTED_TABLES) {
    if (expected[table] === null) blocks.push(`The merge audit is missing a valid ${table} count.`);
  }
  if (expected.payroll_transactions !== null && expected.payroll_transactions < 1) {
    blocks.push("The merge audit does not record any payroll transactions to restore.");
  }
  for (const [table, value] of Object.entries(repointed)) {
    const count = exactCount(value);
    if (!EXPECTED_TABLES.includes(table as (typeof EXPECTED_TABLES)[number]) && count !== null && count > 0) {
      blocks.push(`The merge also changed unsupported child table ${table} (${count} rows).`);
    }
  }

  const transactions = await db.query<TransactionEvidenceRow>(
    `SELECT t.id, t.import_row_id, t.individual_id, t.individual_raw,
            t.source_row_number, r.source_row_number AS import_source_row_number,
            r.resolved_individual_id
       FROM payroll_transactions t
       JOIN import_rows r ON r.id = t.import_row_id
      WHERE t.individual_id = $1
        AND r.resolved_individual_id = $2
      ORDER BY t.id${lock}`,
    [input.survivorId, input.foldedId],
  );
  const evidenceName = normalizePersonName(input.evidenceSourceName);
  const validTransactions = transactions.rows.filter((row) => normalizePersonName(row.individual_raw) === evidenceName);
  if (validTransactions.length !== transactions.rows.length) {
    blocks.push("Some provenance-linked transactions do not carry the confirmed folded source spelling.");
  }

  const survivorRows = await db.query<Pick<TransactionEvidenceRow, "id" | "individual_raw" | "resolved_individual_id">>(
    `SELECT t.id, t.individual_raw, r.resolved_individual_id
       FROM payroll_transactions t
       LEFT JOIN import_rows r ON r.id = t.import_row_id
      WHERE t.individual_id = $1`,
    [input.survivorId],
  );
  const unexplainedSourceRows = survivorRows.rows.filter((row) => (
    normalizePersonName(row.individual_raw) === evidenceName
    && row.resolved_individual_id !== input.foldedId
  ));
  if (unexplainedSourceRows.length > 0) {
    blocks.push(`${unexplainedSourceRows.length} survivor transaction(s) use the folded source spelling without folded-person import provenance.`);
  }

  const transactionIds = uniqueSorted(validTransactions.map((row) => row.id));
  const importRowIds = uniqueSorted(validTransactions.map((row) => row.import_row_id));
  const sourceRows = [...new Set(validTransactions.map((row) => row.source_row_number ?? row.import_source_row_number))].sort((a, b) => a - b);
  report.evidence.transactionCount = transactionIds.length;
  report.evidence.importRowCount = importRowIds.length;
  report.evidence.sourceRows = sourceRows;
  if (expected.payroll_transactions !== null && transactionIds.length !== expected.payroll_transactions) {
    blocks.push(`Evidence identifies ${transactionIds.length} transaction(s), but the merge audit recorded ${expected.payroll_transactions}.`);
  }

  const allocations = transactionIds.length === 0
    ? { rows: [] as AllocationEvidenceRow[] }
    : await db.query<AllocationEvidenceRow>(
      `SELECT id, individual_id, payroll_transaction_id, service_session_id
         FROM service_allocations
        WHERE payroll_transaction_id = ANY($1::uuid[])
        ORDER BY id${lock}`,
      [transactionIds],
    );
  const validAllocations = allocations.rows.filter((row) => row.individual_id === input.survivorId);
  if (validAllocations.length !== allocations.rows.length) {
    blocks.push("Some allocations linked to the evidence transactions are not owned by the survivor.");
  }
  const allocationIds = uniqueSorted(validAllocations.map((row) => row.id));
  report.evidence.allocationCount = allocationIds.length;
  if (expected.service_allocations !== null && allocationIds.length !== expected.service_allocations) {
    blocks.push(`Evidence identifies ${allocationIds.length} allocation(s), but the merge audit recorded ${expected.service_allocations}.`);
  }

  if (validAllocations.length > 0) {
    const conflicts = await db.query<{ id: string }>(
      `SELECT target.id
         FROM service_allocations source
         JOIN service_allocations target
           ON target.service_session_id = source.service_session_id
          AND target.individual_id = $2
          AND target.id <> source.id
        WHERE source.id = ANY($1::uuid[])
        LIMIT 1`,
      [allocationIds, input.foldedId],
    );
    if (conflicts.rows[0]) blocks.push("Restoring an allocation would collide with an existing folded-person session allocation.");
  }

  const warnings = importRowIds.length === 0
    ? { rows: [] as WarningEvidenceRow[] }
    : await db.query<WarningEvidenceRow>(
      `SELECT id, individual_id, import_row_id
         FROM import_warnings
        WHERE import_row_id = ANY($1::uuid[])
          AND individual_id = $2
        ORDER BY id${lock}`,
      [importRowIds, input.survivorId],
    );
  const warningIds = uniqueSorted(warnings.rows.map((row) => row.id));
  report.evidence.warningCount = warningIds.length;
  if (expected.import_warnings !== null && warningIds.length !== expected.import_warnings) {
    blocks.push(`Evidence identifies ${warningIds.length} warning(s), but the merge audit recorded ${expected.import_warnings}.`);
  }

  const aliases = audit
    ? await db.query<AliasRow>(
      `SELECT a.id, a.individual_id, a.normalized_alias, a.source_text, a.status,
              a.created_at::text, a.approved_at::text, a.approved_by_user_id,
              abs(extract(epoch FROM (a.created_at - $2::timestamptz))) <= 30 AS merge_created
         FROM individual_aliases a
        WHERE a.normalized_alias = $1${lock}`,
      [evidenceName, audit.created_at],
    )
    : { rows: [] as AliasRow[] };
  const alias = aliases.rows[0] ?? null;
  if (
    aliases.rows.length !== 1
    || !alias
    || alias.individual_id !== input.survivorId
    || alias.status !== "approved"
    || normalizePersonName(alias.source_text) !== evidenceName
    || !alias.merge_created
  ) {
    blocks.push("The merge-created approved alias cannot be identified unambiguously.");
  }

  const reviews = await db.query<ReviewRow>(
    `SELECT id, keep_individual_id, merge_individual_id, status, reason,
            decided_by_user_id, decided_at::text
       FROM individual_match_reviews
      WHERE (keep_individual_id = $1 AND merge_individual_id = $2)
         OR (keep_individual_id = $2 AND merge_individual_id = $1)${lock}`,
    [input.survivorId, input.foldedId],
  );
  const review = reviews.rows[0] ?? null;
  if (reviews.rows.length !== 1 || !review || review.status !== "confirmed") {
    blocks.push("The confirmed human match-review row cannot be identified unambiguously.");
  }

  report.evidence.provenanceDigestSha256 = transactionIds.length > 0
    ? provenanceDigest({ transactionIds, importRowIds, allocationIds, warningIds })
    : null;
  report.actions = {
    restoreFoldedIndividual: Boolean(folded),
    restoreTransactions: transactionIds.length,
    restoreAllocations: allocationIds.length,
    restoreWarnings: warningIds.length,
    archiveMergeAlias: Boolean(alias),
    rejectMergeReview: Boolean(review),
  };
  report.eligible = blocks.length === 0;
  report.outcome = report.eligible ? "ready" : "blocked";

  return {
    report,
    transactionIds,
    importRowIds,
    allocationIds,
    warningIds,
    aliasId: alias?.id ?? null,
    reviewId: review?.id ?? null,
    aliasBefore: alias,
    reviewBefore: review,
    foldedBefore: folded,
  };
}

async function updateExactIds(
  client: PgLikeClient,
  sql: string,
  ids: readonly string[],
  params: unknown[],
  label: string,
): Promise<void> {
  if (ids.length === 0) return;
  const result = await client.query<{ id: string }>(sql, params);
  if (result.rows.length !== ids.length) {
    throw new Error(`${label} changed while the correction was being applied; the transaction was rolled back.`);
  }
}

/**
 * Undo one proven incorrect individual merge without guessing.
 *
 * Dry-run is the default and is executed inside a read-only transaction. Apply
 * is allowed only when the original audit metadata, current merge state,
 * immutable import-row identity, source spelling, alias, review, and exact child
 * counts all agree. It updates only the IDs in that evidence set, never every
 * row currently owned by the survivor. A correction audit makes retries no-ops.
 */
export async function reconcileIncorrectIndividualMerge(
  pool: PgLikePool,
  input: IndividualMergeCorrectionInput,
  options: { apply?: boolean; actorId?: string | null } = {},
): Promise<IndividualMergeCorrectionReport> {
  validateInput(input);
  const apply = options.apply === true;
  const actorId = options.actorId ?? null;
  if (apply && (!actorId || !UUID.test(actorId))) {
    throw new Error("Apply mode requires a valid actorId for the correction audit trail.");
  }

  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query(apply ? "BEGIN" : "BEGIN TRANSACTION READ ONLY");
    transactionOpen = true;
    if (apply) {
      await acquireSettlementSourceLock(client);
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `individual-merge-correction:${input.mergeAuditLogId}`,
      ]);
    }

    const plan = await buildPlan(client, input, apply ? "apply" : "dry-run", apply);
    if (!apply || plan.report.outcome === "already-applied" || !plan.report.eligible) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return plan.report;
    }

    const actor = await client.query<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [actorId]);
    if (!actor.rows[0]) {
      plan.report.outcome = "blocked";
      plan.report.eligible = false;
      plan.report.blocks.push("The apply actor does not exist, so an attributable correction cannot be recorded.");
      await client.query("ROLLBACK");
      transactionOpen = false;
      return plan.report;
    }

    await updateExactIds(
      client,
      `UPDATE payroll_transactions
          SET individual_id = $2, updated_at = now()
        WHERE id = ANY($1::uuid[]) AND individual_id = $3
        RETURNING id`,
      plan.transactionIds,
      [plan.transactionIds, input.foldedId, input.survivorId],
      "Payroll transaction evidence",
    );
    await updateExactIds(
      client,
      `UPDATE service_allocations
          SET individual_id = $2, updated_at = now()
        WHERE id = ANY($1::uuid[]) AND individual_id = $3
        RETURNING id`,
      plan.allocationIds,
      [plan.allocationIds, input.foldedId, input.survivorId],
      "Service allocation evidence",
    );
    await updateExactIds(
      client,
      `UPDATE import_warnings
          SET individual_id = $2, updated_at = now()
        WHERE id = ANY($1::uuid[]) AND individual_id = $3
        RETURNING id`,
      plan.warningIds,
      [plan.warningIds, input.foldedId, input.survivorId],
      "Import warning evidence",
    );

    const restoredPerson = await client.query<{ id: string }>(
      `UPDATE individuals
          SET status = 'active', archived_at = NULL, merged_into_id = NULL, updated_at = now()
        WHERE id = $1 AND status = 'archived' AND merged_into_id = $2 AND archived_at IS NOT NULL
        RETURNING id`,
      [input.foldedId, input.survivorId],
    );
    if (restoredPerson.rows.length !== 1) throw new Error("The folded individual changed; the correction was rolled back.");

    const archivedAlias = await client.query<{ id: string }>(
      `UPDATE individual_aliases
          SET status = 'archived', archived_at = now(), updated_at = now()
        WHERE id = $1 AND individual_id = $2 AND status = 'approved'
        RETURNING id`,
      [plan.aliasId, input.survivorId],
    );
    if (archivedAlias.rows.length !== 1) throw new Error("The merge alias changed; the correction was rolled back.");

    const rejectedReview = await client.query<{ id: string }>(
      `UPDATE individual_match_reviews
          SET status = 'rejected', decided_by_user_id = $2, decided_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'confirmed'
        RETURNING id`,
      [plan.reviewId, actorId],
    );
    if (rejectedReview.rows.length !== 1) throw new Error("The merge review changed; the correction was rolled back.");

    await recordChange(client, {
      actorId,
      action: CORRECTION_ACTION,
      entityType: "individual",
      entityId: input.foldedId,
      reason: input.reason.trim(),
      previous: {
        status: plan.foldedBefore?.status,
        archivedAt: plan.foldedBefore?.archived_at,
        mergedIntoId: plan.foldedBefore?.merged_into_id,
      },
      next: { status: "active", archivedAt: null, mergedIntoId: null },
      extra: {
        mergeAuditLogId: input.mergeAuditLogId,
        foldedId: input.foldedId,
        foldedName: input.expectedFoldedName,
        survivorId: input.survivorId,
        survivorName: input.expectedSurvivorName,
        evidenceSourceName: input.evidenceSourceName,
        provenanceDigestSha256: plan.report.evidence.provenanceDigestSha256,
        transactionIds: plan.transactionIds,
        importRowIds: plan.importRowIds,
        allocationIds: plan.allocationIds,
        warningIds: plan.warningIds,
        aliasId: plan.aliasId,
        matchReviewId: plan.reviewId,
        retiredAlias: plan.aliasBefore ? {
          id: plan.aliasBefore.id,
          individualId: plan.aliasBefore.individual_id,
          status: plan.aliasBefore.status,
          approvedByUserId: plan.aliasBefore.approved_by_user_id,
          approvedAt: plan.aliasBefore.approved_at,
          createdAt: plan.aliasBefore.created_at,
        } : null,
        reversedMatchReview: plan.reviewBefore ? {
          id: plan.reviewBefore.id,
          keepIndividualId: plan.reviewBefore.keep_individual_id,
          mergeIndividualId: plan.reviewBefore.merge_individual_id,
          status: plan.reviewBefore.status,
          reason: plan.reviewBefore.reason,
          decidedByUserId: plan.reviewBefore.decided_by_user_id,
          decidedAt: plan.reviewBefore.decided_at,
        } : null,
        restored: {
          payrollTransactions: plan.transactionIds.length,
          serviceAllocations: plan.allocationIds.length,
          importWarnings: plan.warningIds.length,
          importRows: plan.importRowIds.length,
        },
      },
    });
    const correctionAudit = await client.query<{ id: string }>(
      `SELECT id
         FROM audit_logs
        WHERE action = $1
          AND metadata->>'mergeAuditLogId' = $2
          AND metadata->>'foldedId' = $3
          AND metadata->>'survivorId' = $4
        ORDER BY created_at DESC
        LIMIT 1`,
      [CORRECTION_ACTION, input.mergeAuditLogId, input.foldedId, input.survivorId],
    );

    await client.query("COMMIT");
    transactionOpen = false;
    return {
      ...plan.report,
      outcome: "applied",
      eligible: false,
      correctionAuditLogId: correctionAudit.rows[0]?.id ?? null,
    };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
