import type { PgLikePool } from "@/lib/import/commit";
import { ok, fail, type Result } from "@/lib/manage/errors";
import { recordChange } from "@/lib/manage/audit";
import { findMatchCandidates, type IndividualForMatch } from "@/lib/business/individual-matching";
import { similarity } from "@/lib/business/name-matching";
import { repointSettlementPerson } from "@/lib/manage/settlement-person-merge";
import { acquireSettlementSourceLock } from "@/lib/manage/settlement-freshness";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Merge one individual row into another: every child row that references the
 * folded-in person is repointed to the survivor, an approved alias records the
 * old spelling (so future imports resolve to the survivor), and the folded-in
 * row is archived — never deleted, so the change is auditable and reversible.
 */
export async function mergeIndividuals(
  pool: PgLikePool,
  input: { keepId: string; mergeId: string },
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ keepId: string; mergeId: string; repointed: Record<string, number> }>> {
  const { keepId, mergeId } = input;
  if (!UUID.test(keepId) || !UUID.test(mergeId)) return fail("validation", "Valid individuals are required.");
  if (keepId === mergeId) return fail("validation", "Cannot merge an individual into itself.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await acquireSettlementSourceLock(client);
    const both = await client.query<{ id: string; display_name: string; normalized_name: string; status: string; merged_into_id: string | null }>(
      `SELECT id, display_name, normalized_name, status, merged_into_id FROM individuals WHERE id = ANY($1::uuid[]) FOR UPDATE`,
      [[keepId, mergeId]],
    );
    const keep = both.rows.find((r) => r.id === keepId);
    const merge = both.rows.find((r) => r.id === mergeId);
    if (!keep || !merge) {
      await client.query("ROLLBACK");
      return fail("not_found", "One of the individuals no longer exists.");
    }
    if (merge.merged_into_id) {
      await client.query("ROLLBACK");
      return fail("conflict", "That individual was already merged.");
    }

    // Repoint every base table that has an individual_id column (robust to
    // schema growth). Class billing needs a deliberate order because issued
    // invoices are immutable and profiles are unique per individual.
    const cols = await client.query<{ table_name: string }>(
      `SELECT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = current_schema()
          AND c.column_name = 'individual_id'
          AND t.table_type = 'BASE TABLE'`,
    );

    const overlappingProgramBudgets = await client.query<{ id: string }>(
      `SELECT source.id
         FROM budget_authorizations source
         JOIN budget_periods source_period ON source_period.id = source.budget_period_id
         JOIN budget_authorizations target
           ON target.individual_id = $1
          AND target.program_id = source.program_id
          AND target.status = 'active'
          AND target.archived_at IS NULL
         JOIN budget_periods target_period ON target_period.id = target.budget_period_id
        WHERE source.individual_id = $2
          AND source.status = 'active'
          AND source.archived_at IS NULL
          AND source_period.archived_at IS NULL
          AND target_period.archived_at IS NULL
          AND daterange(target_period.start_date, target_period.end_date, '[]')
              && daterange(source_period.start_date, source_period.end_date, '[]')
        LIMIT 1`,
      [keepId, mergeId],
    );
    if (overlappingProgramBudgets.rows[0]) {
      await client.query("ROLLBACK");
      return fail(
        "conflict",
        "Resolve overlapping active program authorizations before merging these individuals.",
      );
    }
    const repointed: Record<string, number> = await repointSettlementPerson(client, "individual", keepId, mergeId);

    const movedLegacyAccess = await client.query(
      `INSERT INTO user_individual_access (user_id, individual_id, created_at)
       SELECT user_id, $1, created_at
         FROM user_individual_access
        WHERE individual_id = $2
       ON CONFLICT (user_id, individual_id) DO NOTHING`,
      [keepId, mergeId],
    );
    await client.query(`DELETE FROM user_individual_access WHERE individual_id = $1`, [mergeId]);
    if (movedLegacyAccess.rowCount) repointed.user_individual_access = movedLegacyAccess.rowCount;

    const movedPortalRelationships = await client.query(
      `INSERT INTO user_individual_relationships
         (user_id, individual_id, relationship_type, is_active, capability_grants,
          capability_denials, created_by_user_id, updated_by_user_id, created_at, updated_at)
       SELECT user_id, $1, relationship_type, is_active, capability_grants,
              capability_denials, created_by_user_id, $3, created_at, now()
         FROM user_individual_relationships
        WHERE individual_id = $2
       ON CONFLICT (user_id, individual_id, relationship_type) DO UPDATE SET
         is_active = user_individual_relationships.is_active OR EXCLUDED.is_active,
         capability_grants = ARRAY(
           SELECT DISTINCT capability
             FROM unnest(user_individual_relationships.capability_grants || EXCLUDED.capability_grants) capability
            ORDER BY capability
         ),
         capability_denials = ARRAY(
           SELECT DISTINCT capability
             FROM unnest(user_individual_relationships.capability_denials || EXCLUDED.capability_denials) capability
            ORDER BY capability
         ),
         updated_by_user_id = $3,
         updated_at = now()`,
      [keepId, mergeId, actorId],
    );
    await client.query(`DELETE FROM user_individual_relationships WHERE individual_id = $1`, [mergeId]);
    if (movedPortalRelationships.rowCount) {
      repointed.user_individual_relationships = movedPortalRelationships.rowCount;
    }

    await client.query(
      `SELECT pg_advisory_xact_lock(lock_key)
         FROM (
           SELECT DISTINCT hashtextextended(
                    'agency_individuals:' || agency_id::text || ':' || person_id::text,
                    0
                  ) AS lock_key
             FROM agency_individuals
             CROSS JOIN LATERAL unnest($1::uuid[]) AS people(person_id)
            WHERE individual_id = ANY($1::uuid[])
            ORDER BY lock_key
         ) timeline_locks`,
      [[keepId, mergeId]],
    );
    const overlappingAgencyMemberships = await client.query<{ id: string }>(
      `SELECT source.id
         FROM agency_individuals source
         JOIN agency_individuals target
           ON target.agency_id = source.agency_id
          AND target.individual_id = $1
          AND target.is_active = true
          AND daterange(target.effective_from, target.effective_to, '[]')
              && daterange(source.effective_from, source.effective_to, '[]')
        WHERE source.individual_id = $2
          AND source.is_active = true
        LIMIT 1`,
      [keepId, mergeId],
    );
    if (overlappingAgencyMemberships.rows[0]) {
      await client.query("ROLLBACK");
      return fail(
        "conflict",
        "Resolve overlapping agency membership history before merging these individuals.",
      );
    }
    const movedAgencyMemberships = await client.query(
      `UPDATE agency_individuals
          SET individual_id = $1, updated_by_user_id = $3, updated_at = now()
        WHERE individual_id = $2`,
      [keepId, mergeId, actorId],
    );
    if (movedAgencyMemberships.rowCount) repointed.agency_individuals = movedAgencyMemberships.rowCount;

    const overlappingClassBudgets = await client.query<{ id: string }>(
      `SELECT source.id
         FROM class_budget_periods source
         JOIN class_budget_periods target
           ON target.individual_id = $1
          AND target.status = 'active'
          AND daterange(target.start_date, target.end_date, '[]')
              && daterange(source.start_date, source.end_date, '[]')
        WHERE source.individual_id = $2
          AND source.status = 'active'
        LIMIT 1`,
      [keepId, mergeId],
    );
    if (overlappingClassBudgets.rows[0]) {
      await client.query("ROLLBACK");
      return fail("conflict", "Resolve the overlapping active class allowances before merging these individuals.");
    }

    const movedClassBudgets = await client.query(
      `UPDATE class_budget_periods SET individual_id = $1, updated_at = now() WHERE individual_id = $2`,
      [keepId, mergeId],
    );
    if (movedClassBudgets.rowCount) repointed.class_budget_periods = movedClassBudgets.rowCount;
    const movedClassInvoices = await client.query(
      `UPDATE class_invoices SET individual_id = $1 WHERE individual_id = $2`,
      [keepId, mergeId],
    );
    if (movedClassInvoices.rowCount) repointed.class_invoices = movedClassInvoices.rowCount;

    const profiles = await client.query<{
      id: string;
      individual_id: string;
      mailing_name: string | null;
      address_line_1: string | null;
      address_line_2: string | null;
      city_state_zip: string | null;
      phone: string | null;
      date_of_birth: string | null;
      medicaid_id: string | null;
      fiscal_intermediary: string;
      payable_to: string;
      life_plan_confirmed: boolean;
      budget_category: string;
      form_completed_by: string | null;
      relationship: string | null;
    }>(
      `SELECT id, individual_id, mailing_name, address_line_1, address_line_2,
              city_state_zip, phone, date_of_birth::text AS date_of_birth,
              medicaid_id, fiscal_intermediary, payable_to,
              life_plan_confirmed, budget_category, form_completed_by, relationship
         FROM class_reimbursement_profiles
        WHERE individual_id = ANY($1::uuid[])
        FOR UPDATE`,
      [[keepId, mergeId]],
    );
    const keepProfile = profiles.rows.find((row) => row.individual_id === keepId);
    const mergeProfile = profiles.rows.find((row) => row.individual_id === mergeId);
    if (mergeProfile && keepProfile) {
      const sensitiveFields = [
        "mailing_name", "address_line_1", "address_line_2", "city_state_zip",
        "phone", "date_of_birth", "medicaid_id", "fiscal_intermediary",
        "payable_to", "budget_category", "form_completed_by", "relationship",
      ] as const;
      const conflicting = sensitiveFields.some((field) => (
        keepProfile[field] !== null
        && mergeProfile[field] !== null
        && keepProfile[field] !== mergeProfile[field]
      )) || keepProfile.life_plan_confirmed !== mergeProfile.life_plan_confirmed;
      if (conflicting) {
        await client.query("ROLLBACK");
        return fail("conflict", "These individuals have different reimbursement profiles. Review and align them before merging.");
      }
      await client.query(
        `UPDATE class_reimbursement_profiles target
            SET mailing_name = COALESCE(target.mailing_name, source.mailing_name),
                address_line_1 = COALESCE(target.address_line_1, source.address_line_1),
                address_line_2 = COALESCE(target.address_line_2, source.address_line_2),
                city_state_zip = COALESCE(target.city_state_zip, source.city_state_zip),
                phone = COALESCE(target.phone, source.phone),
                date_of_birth = COALESCE(target.date_of_birth, source.date_of_birth),
                medicaid_id = COALESCE(target.medicaid_id, source.medicaid_id),
                fiscal_intermediary = COALESCE(target.fiscal_intermediary, source.fiscal_intermediary),
                payable_to = COALESCE(target.payable_to, source.payable_to),
                budget_category = COALESCE(target.budget_category, source.budget_category),
                form_completed_by = COALESCE(target.form_completed_by, source.form_completed_by),
                relationship = COALESCE(target.relationship, source.relationship),
                updated_by_user_id = $3,
                updated_at = now()
           FROM class_reimbursement_profiles source
          WHERE target.id = $1 AND source.id = $2`,
        [keepProfile.id, mergeProfile.id, actorId],
      );
      await client.query(`DELETE FROM class_reimbursement_profiles WHERE id = $1`, [mergeProfile.id]);
      repointed.class_reimbursement_profiles = 1;
    } else if (mergeProfile) {
      const movedProfile = await client.query(
        `UPDATE class_reimbursement_profiles
            SET individual_id = $1, updated_by_user_id = $3, updated_at = now()
          WHERE id = $2`,
        [keepId, mergeProfile.id, actorId],
      );
      if (movedProfile.rowCount) repointed.class_reimbursement_profiles = movedProfile.rowCount;
    }

    for (const { table_name } of cols.rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(table_name)) continue;
      if ([
        "settlement_events",
        "settlement_obligations",
        "class_budget_periods",
        "class_invoices",
        "class_reimbursement_profiles",
        "user_individual_access",
        "user_individual_relationships",
        "agency_individuals",
      ].includes(table_name)) continue;
      const res = await client.query(
        `UPDATE "${table_name}" SET individual_id = $1 WHERE individual_id = $2`,
        [keepId, mergeId],
      );
      if (res.rowCount) repointed[table_name] = res.rowCount;
    }

    // Record the old spelling as an approved alias → future imports resolve to the survivor.
    await client.query(
      `INSERT INTO individual_aliases (individual_id, normalized_alias, source_text, status, approved_by_user_id, approved_at)
       VALUES ($1, $2, $3, 'approved', $4, now())
       ON CONFLICT (normalized_alias) DO UPDATE
         SET individual_id = EXCLUDED.individual_id, status = 'approved', approved_by_user_id = EXCLUDED.approved_by_user_id, approved_at = now()`,
      [keepId, merge.normalized_name, merge.display_name, actorId],
    );

    // Archive the folded-in row and point it at the survivor.
    await client.query(
      `UPDATE individuals SET status = 'archived', merged_into_id = $1, archived_at = now(), updated_at = now() WHERE id = $2`,
      [keepId, mergeId],
    );

    // Any pending review touching the folded-in row is now moot.
    await client.query(
      `UPDATE individual_match_reviews SET status = 'confirmed', decided_by_user_id = $1, decided_at = now(), updated_at = now()
        WHERE status = 'pending' AND (keep_individual_id = $2 OR merge_individual_id = $2)`,
      [actorId, mergeId],
    );

    await recordChange(client, {
      actorId,
      action: "individuals_merged",
      entityType: "individual",
      entityId: keepId,
      reason: reason ?? null,
      extra: { mergedId: mergeId, mergedName: merge.display_name, repointed },
    });

    await client.query("COMMIT");
    return ok({ keepId, mergeId, repointed });
  } catch (error) {
    await client.query("ROLLBACK");
    return fail("validation", error instanceof Error ? error.message : "Merge failed.");
  } finally {
    client.release();
  }
}

/** Active, un-merged individuals with a weight (transaction count) for match scanning. */
export async function loadIndividualsForMatch(pool: PgLikePool): Promise<IndividualForMatch[]> {
  const { rows } = await pool.query<{ id: string; normalized_name: string; display_name: string; weight: string }>(
    `SELECT i.id, i.normalized_name, i.display_name,
            (SELECT count(*) FROM payroll_transactions t WHERE t.individual_id = i.id)::text AS weight
       FROM individuals i
      WHERE i.status <> 'archived' AND i.merged_into_id IS NULL`,
  );
  return rows.map((r) => ({ id: r.id, normalizedName: r.normalized_name, displayName: r.display_name, weight: Number(r.weight) }));
}

const pairKey = (a: string, b: string) => [a, b].sort().join(":");

/**
 * Scan for near-duplicate individuals. Confident single-token typos are merged
 * automatically; uncertain pairs are queued for review; pairs a human already
 * rejected are left alone.
 */
export async function scanMatches(
  pool: PgLikePool,
  actorId: string | null,
): Promise<Result<{ merged: number; queued: number; candidates: number }>> {
  const individuals = await loadIndividualsForMatch(pool);
  const candidates = findMatchCandidates(individuals);

  // Remember rejected pairs so we do not re-suggest them.
  const decided = await pool.query<{ keep_individual_id: string; merge_individual_id: string; status: string }>(
    `SELECT keep_individual_id, merge_individual_id, status FROM individual_match_reviews`,
  );
  const rejected = new Set(decided.rows.filter((r) => r.status === "rejected").map((r) => pairKey(r.keep_individual_id, r.merge_individual_id)));

  const mergedIds = new Set<string>();
  let merged = 0;
  let queued = 0;

  for (const c of candidates) {
    if (rejected.has(pairKey(c.keep.id, c.merge.id))) continue;
    if (mergedIds.has(c.keep.id) || mergedIds.has(c.merge.id)) continue; // chain safety

    if (c.kind === "auto") {
      const res = await mergeIndividuals(pool, { keepId: c.keep.id, mergeId: c.merge.id }, actorId, `Auto-merged: ${c.reason}`);
      if (res.ok) {
        mergedIds.add(c.merge.id);
        merged++;
      }
    } else if (c.kind === "review") {
      const up = await pool.query(
        `INSERT INTO individual_match_reviews (keep_individual_id, merge_individual_id, score, reason, status)
         VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (keep_individual_id, merge_individual_id) DO NOTHING`,
        [c.keep.id, c.merge.id, c.score.toFixed(4), c.reason],
      );
      if (up.rowCount) queued++;
    }
  }

  await recordChange(pool, {
    actorId,
    action: "individual_match_scan",
    entityType: "individual",
    entityId: null,
    extra: { merged, queued, candidates: candidates.length },
  });
  return ok({ merged, queued, candidates: candidates.length });
}

export interface MatchReviewRow {
  id: string;
  keepId: string;
  keepName: string;
  keepTransactions: number;
  keepStrategies: number;
  mergeId: string;
  mergeName: string;
  mergeTransactions: number;
  mergeStrategies: number;
  score: string;
  reason: string | null;
  status: string;
  createdAt: string;
}

export async function listMatchReviews(pool: PgLikePool, opts: { status?: string } = {}): Promise<MatchReviewRow[]> {
  const status = opts.status ?? "pending";
  const { rows } = await pool.query<{
    id: string; keep_id: string; keep_name: string; keep_tx: string; keep_strat: string;
    merge_id: string; merge_name: string; merge_tx: string; merge_strat: string;
    score: string; reason: string | null; status: string; created_at: string;
  }>(
    `SELECT r.id,
            k.id AS keep_id, k.display_name AS keep_name,
            (SELECT count(*) FROM payroll_transactions t WHERE t.individual_id = k.id)::text AS keep_tx,
            (SELECT count(*) FROM calculation_strategies s WHERE s.individual_id = k.id AND s.status = 'active')::text AS keep_strat,
            m.id AS merge_id, m.display_name AS merge_name,
            (SELECT count(*) FROM payroll_transactions t WHERE t.individual_id = m.id)::text AS merge_tx,
            (SELECT count(*) FROM calculation_strategies s WHERE s.individual_id = m.id AND s.status = 'active')::text AS merge_strat,
            r.score::text, r.reason, r.status, r.created_at::text
       FROM individual_match_reviews r
       JOIN individuals k ON k.id = r.keep_individual_id
       JOIN individuals m ON m.id = r.merge_individual_id
      WHERE r.status = $1
      ORDER BY r.score DESC`,
    [status],
  );
  return rows.map((r) => ({
    id: r.id,
    keepId: r.keep_id,
    keepName: r.keep_name,
    keepTransactions: Number(r.keep_tx),
    keepStrategies: Number(r.keep_strat),
    mergeId: r.merge_id,
    mergeName: r.merge_name,
    mergeTransactions: Number(r.merge_tx),
    mergeStrategies: Number(r.merge_strat),
    score: r.score,
    reason: r.reason,
    status: r.status,
    createdAt: r.created_at,
  }));
}

export async function decideMatchReview(
  pool: PgLikePool,
  input: { id: string; decision: "confirm" | "reject"; keepId?: string; mergeId?: string },
  actorId: string | null,
  reason?: string | null,
): Promise<Result<{ id: string }>> {
  if (!UUID.test(input.id)) return fail("validation", "A valid review is required.");
  const { rows } = await pool.query<{ keep_individual_id: string; merge_individual_id: string; status: string }>(
    `SELECT keep_individual_id, merge_individual_id, status FROM individual_match_reviews WHERE id = $1`,
    [input.id],
  );
  const review = rows[0];
  if (!review) return fail("not_found", "That review no longer exists.");
  if (review.status !== "pending") return fail("conflict", "That review was already decided.");

  if (input.decision === "reject") {
    await pool.query(
      `UPDATE individual_match_reviews SET status = 'rejected', decided_by_user_id = $1, decided_at = now(), updated_at = now() WHERE id = $2`,
      [actorId, input.id],
    );
    await recordChange(pool, { actorId, action: "individual_match_rejected", entityType: "individual", entityId: review.keep_individual_id, reason: reason ?? null, extra: { reviewId: input.id } });
    return ok({ id: input.id });
  }

  // Confirm → merge. Respect a caller-chosen direction if provided (which row survives).
  const keepId = input.keepId ?? review.keep_individual_id;
  const mergeId = input.mergeId ?? review.merge_individual_id;
  const res = await mergeIndividuals(pool, { keepId, mergeId }, actorId, reason ?? "Confirmed match");
  if (!res.ok) return res;
  await pool.query(
    `UPDATE individual_match_reviews SET status = 'confirmed', decided_by_user_id = $1, decided_at = now(), updated_at = now() WHERE id = $2`,
    [actorId, input.id],
  );
  return ok({ id: input.id });
}

export interface MergeCandidate {
  id: string;
  name: string;
  txCount: number;
  hasPlan: boolean;
  billedAgency: string; // total agency billed, for context
  similarity: number; // 0..1 name similarity to the target
}

/**
 * Other individual records that could be the SAME person as `individualId` —
 * used to connect a budgeted person to transactions that came in under a
 * different name (a nickname, maiden name, or transliteration mints a separate
 * individual row on import). Ranked by name similarity, then by how much billing
 * they carry (the more they've billed, the more it matters to fold them in).
 * A free-text `q` narrows by name so an operator can find a spelling the
 * similarity score wouldn't surface on its own.
 */
export async function listMergeCandidates(
  pool: PgLikePool,
  individualId: string,
  q?: string | null,
): Promise<MergeCandidate[]> {
  if (!UUID.test(individualId)) return [];
  const target = await pool.query<{ normalized_name: string }>(
    `SELECT normalized_name FROM individuals WHERE id = $1`,
    [individualId],
  );
  const targetName = target.rows[0]?.normalized_name ?? "";
  const search = q && q.trim() ? `%${q.trim()}%` : null;

  const { rows } = await pool.query<{
    id: string;
    name: string;
    normalized_name: string;
    tx_count: number;
    billed_agency: string;
    has_plan: boolean;
  }>(
    `SELECT i.id,
            COALESCE(i.display_name, i.normalized_name) AS name,
            i.normalized_name,
            (SELECT count(*) FROM payroll_transactions t WHERE t.individual_id = i.id)::int AS tx_count,
            COALESCE((SELECT sum(t.imported_amount) FROM payroll_transactions t WHERE t.individual_id = i.id), 0)::text AS billed_agency,
            EXISTS (SELECT 1 FROM calculation_strategies cs
                     WHERE cs.individual_id = i.id AND cs.status = 'active' AND cs.renewal_date IS NOT NULL) AS has_plan
       FROM individuals i
      WHERE i.id <> $1
        AND i.merged_into_id IS NULL
        AND i.status <> 'archived'
        AND ($2::text IS NULL OR i.display_name ILIKE $2 OR i.normalized_name ILIKE $2)
      ORDER BY tx_count DESC
      LIMIT 100`,
    [individualId, search],
  );

  const scored = rows.map((r) => ({
    id: r.id,
    name: r.name,
    txCount: r.tx_count,
    hasPlan: r.has_plan,
    billedAgency: r.billed_agency,
    similarity: targetName ? similarity(targetName, r.normalized_name) : 0,
  }));
  // When searching, keep the operator's matches in billing order; otherwise lead
  // with the most name-similar records (the likely same-person duplicates).
  scored.sort((a, b) => (search ? b.txCount - a.txCount : b.similarity - a.similarity || b.txCount - a.txCount));
  return scored.slice(0, 25);
}
