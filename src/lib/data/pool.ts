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
    const detail = redactError(error, "Unknown database error");
    console.error("[withDb] Database-backed view failed:", detail);
    return {
      ok: false,
      error: "This information could not be loaded right now. Refresh the page in a moment.",
    };
  }
}
