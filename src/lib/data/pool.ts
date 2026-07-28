import { getPool } from "@/lib/db";
import type { PgLikePool } from "@/lib/import/commit";
import { redactError } from "@/lib/http";

/**
 * Screens call this instead of getPool() directly so a database outage renders
 * an error state rather than a stack trace, and so nothing that reaches the
 * browser can contain a connection string.
 */
export async function withDb<T>(
  run: (pool: PgLikePool) => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await run(getPool()) };
  } catch (error) {
    return { ok: false, error: redactError(error, "The database is not reachable right now.") };
  }
}
