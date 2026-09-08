import type { PersonIdentityDirectory } from "@/lib/business/person-identity";
import type { PgLikePool } from "@/lib/import/commit";

/** Read current individual identity, explicit merge pointer, and audit evidence together. */
export async function loadIndividualIdentityDirectory(pool: Pick<PgLikePool, "query">): Promise<PersonIdentityDirectory> {
  const { rows } = await pool.query<PersonIdentityDirectory>(`SELECT
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'normalizedName', normalized_name,
      'displayName', display_name, 'status', status, 'mergedIntoId', merged_into_id)), '[]'::jsonb) FROM individuals) AS people,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('normalizedAlias', normalized_alias,
      'targetId', individual_id, 'status', status)), '[]'::jsonb) FROM individual_aliases) AS aliases,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('mergedId', metadata->>'mergedId',
      'survivorId', entity_id, 'mergedName', metadata->>'mergedName')), '[]'::jsonb)
      FROM audit_logs WHERE action = 'individuals_merged' AND entity_type = 'individual') AS merges`);
  if (!rows[0]) throw new Error("Individual identity evidence is unavailable. Refresh the import review.");
  return rows[0];
}
