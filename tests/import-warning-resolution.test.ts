import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import { reviewCommittedDuplicateWarning } from "@/lib/manage/import-warnings";

const WARNING_ID = "11111111-1111-4111-8111-111111111111";
const TRANSACTION_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";

function poolWithWarning(warning: {
  id: string;
  resolved_at: string | null;
  row_status: string;
  transaction_id: string | null;
}) {
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push({ sql, params });
      if (sql.includes("FROM import_warnings w")) return { rows: [warning] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as PgLikePool;
  return { pool, client, statements };
}

describe("committed duplicate warning review", () => {
  it("locks and resolves the warning without changing the ledger transaction", async () => {
    const { pool, client, statements } = poolWithWarning({
      id: WARNING_ID,
      resolved_at: null,
      row_status: "imported",
      transaction_id: TRANSACTION_ID,
    });

    const result = await reviewCommittedDuplicateWarning(pool, WARNING_ID, ACTOR_ID, "Checked source");

    expect(result).toEqual({
      ok: true,
      data: { id: WARNING_ID, transactionId: TRANSACTION_ID, alreadyReviewed: false },
    });
    const lock = statements.find(({ sql }) => sql.includes("FROM import_warnings w"));
    expect(lock?.sql).toContain("FOR UPDATE OF w");
    expect(lock?.sql).toContain("w.category = 'possible_duplicate'");
    expect(lock?.sql).toContain("tx.id AS transaction_id");
    expect(lock?.sql).toContain(") tx ON true");
    const update = statements.find(({ sql }) => sql.includes("UPDATE import_warnings"));
    expect(update?.params).toEqual([WARNING_ID, ACTOR_ID]);
    const audit = statements.find(({ sql }) => sql.includes("INSERT INTO audit_logs"));
    expect(audit?.params).toEqual(expect.arrayContaining([
      ACTOR_ID,
      "import_warning.reviewed",
      "import_warning",
      WARNING_ID,
      "Checked source",
    ]));
    expect(statements.some(({ sql }) => sql === "COMMIT")).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("is idempotent after another reviewer resolves the warning", async () => {
    const { pool, statements } = poolWithWarning({
      id: WARNING_ID,
      resolved_at: "2026-08-30T12:00:00Z",
      row_status: "imported",
      transaction_id: TRANSACTION_ID,
    });

    const result = await reviewCommittedDuplicateWarning(pool, WARNING_ID, ACTOR_ID);

    expect(result).toMatchObject({ ok: true, data: { alreadyReviewed: true } });
    expect(statements.some(({ sql }) => sql.includes("UPDATE import_warnings"))).toBe(false);
    expect(statements.some(({ sql }) => sql.includes("INSERT INTO audit_logs"))).toBe(false);
    expect(statements.some(({ sql }) => sql === "COMMIT")).toBe(true);
  });

  it("refuses to hide a warning whose source is not a committed transaction", async () => {
    const { pool, statements } = poolWithWarning({
      id: WARNING_ID,
      resolved_at: null,
      row_status: "needs_review",
      transaction_id: null,
    });

    const result = await reviewCommittedDuplicateWarning(pool, WARNING_ID, ACTOR_ID);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(statements.some(({ sql }) => sql === "ROLLBACK")).toBe(true);
    expect(statements.some(({ sql }) => sql.includes("UPDATE import_warnings"))).toBe(false);
  });

  it("keeps an imported warning open when its committed transaction is missing", async () => {
    const { pool, statements } = poolWithWarning({
      id: WARNING_ID,
      resolved_at: null,
      row_status: "imported",
      transaction_id: null,
    });

    const result = await reviewCommittedDuplicateWarning(pool, WARNING_ID, ACTOR_ID);

    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(statements.some(({ sql }) => sql === "ROLLBACK")).toBe(true);
    expect(statements.some(({ sql }) => sql.includes("UPDATE import_warnings"))).toBe(false);
  });

  it("rejects malformed warning identities before opening a connection", async () => {
    const connect = vi.fn();
    const result = await reviewCommittedDuplicateWarning({ connect } as unknown as PgLikePool, "not-an-id", ACTOR_ID);
    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expect(connect).not.toHaveBeenCalled();
  });
});
