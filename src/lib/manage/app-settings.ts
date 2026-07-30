import type { PgLikePool } from "@/lib/import/commit";
import { recordChange } from "@/lib/manage/audit";

/**
 * Thin typed accessor over the `app_settings` key/value table (jsonb values).
 * This is the first read/write helper for that table; keep values plain JSON.
 */
export async function getSetting<T = unknown>(
  pool: PgLikePool,
  key: string,
): Promise<T | null> {
  const { rows } = await pool.query<{ value: T }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [key],
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(
  pool: PgLikePool,
  key: string,
  value: unknown,
  actorId: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by_user_id, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at = now()`,
    [key, JSON.stringify(value ?? null), actorId],
  );
  await recordChange(pool, {
    actorId,
    action: "setting_updated",
    entityType: "app_setting",
    entityId: null,
    extra: { key },
  });
}
