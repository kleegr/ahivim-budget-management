import type { PgLikePool } from "@/lib/import/commit";
import { ok, fail, type Result } from "@/lib/manage/errors";
import { recordChange } from "@/lib/manage/audit";
import { findMatchCandidates, type IndividualForMatch } from "@/lib/business/individual-matching";
import { similarity } from "@/lib/business/name-matching";

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

    // Repoint every table that has an individual_id column (robust to schema growth).
    const cols = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name = 'individual_id'`,
    );
    const repointed: Record<string, number> = {};
    for (const { table_name } of cols.rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(table_name)) continue;
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
