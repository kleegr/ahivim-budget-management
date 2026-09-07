import { describe, expect, it, vi } from "vitest";
import type { PgLikeClient, PgLikePool, PgLikeResult } from "@/lib/import/commit";
import { dismissConflict } from "@/lib/sheets/resolve";

const CONFLICT_ID = "11111111-1111-4111-8111-111111111111";
const TRANSACTION_ID = "22222222-2222-4222-8222-222222222222";

describe("Sheet conflict resolution transaction boundary", () => {
  it("rolls back the conflict close and derived flags when the audit insert fails", async () => {
    const statements: string[] = [];
    const query = vi.fn(async <T = Record<string, unknown>>(
      sql: string,
    ): Promise<PgLikeResult<T>> => {
      const normalized = sql.trim();
      statements.push(normalized);
      if (normalized.startsWith("SELECT id, run_id")) {
        return {
          rows: [{
            id: CONFLICT_ID,
            run_id: null,
            sync_row_id: null,
            type: "missing",
            status: "open",
            audited: false,
            natural_key: "key",
            payroll_transaction_id: TRANSACTION_ID,
            previous: {},
            incoming: {},
          } as T],
        };
      }
      if (normalized.startsWith("UPDATE sheet_sync_conflicts")) {
        return { rows: [{ id: CONFLICT_ID } as T] };
      }
      if (normalized.startsWith("SELECT id, source_row_number, identity")) {
        return {
          rows: [{ id: "33333333-3333-4333-8333-333333333333", source_row_number: 2, identity: {} } as T],
        };
      }
      if (normalized.startsWith("SELECT COALESCE(bool_or")) {
        return { rows: [{ has_missing: false, has_changed: false } as T] };
      }
      if (normalized.startsWith("INSERT INTO audit_logs")) {
        throw new Error("injected audit failure");
      }
      return { rows: [] };
    });
    const client = { query, release: vi.fn() } as unknown as PgLikeClient;
    const pool = {
      query,
      connect: vi.fn(async () => client),
    } as unknown as PgLikePool;

    await expect(dismissConflict(pool, CONFLICT_ID, null)).rejects.toThrow("injected audit failure");

    expect(statements[0]).toBe("BEGIN");
    expect(statements.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(statements.some((sql) => sql.includes("FROM sheet_sync_conflicts") && sql.endsWith("FOR UPDATE"))).toBe(true);
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
