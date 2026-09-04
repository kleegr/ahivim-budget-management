import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";
import { autoReconcile } from "@/lib/manage/reconciliation";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_SESSION_ID = "00000000-0000-4000-8000-000000000008";
const TRANSACTION_ID = "00000000-0000-4000-8000-000000000002";
const EMPLOYEE_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_EMPLOYEE_ID = "00000000-0000-4000-8000-000000000004";
const INDIVIDUAL_ID = "00000000-0000-4000-8000-000000000005";
const PROGRAM_ID = "00000000-0000-4000-8000-000000000006";

const session = {
  id: SESSION_ID,
  program_id: PROGRAM_ID,
  session_date: "2026-08-12",
  individual_id: INDIVIDUAL_ID,
  allocation_count: 1,
  employee_id: EMPLOYEE_ID,
  duration_hours: "3.0000",
  is_group: false,
  group_size: 1,
};

const exactCandidate = {
  id: TRANSACTION_ID,
  employee_id: EMPLOYEE_ID,
  imported_hours: "3.0000",
  period_begin: "2026-08-12",
  period_end: "2026-08-12",
  is_group_service: false,
};

type SessionFixture = Omit<typeof session, "individual_id" | "employee_id" | "allocation_count"> & {
  individual_id: string | null;
  employee_id: string | null;
  allocation_count: number;
};

function poolFor(
  sessions: SessionFixture[],
  candidates: Array<typeof exactCandidate>,
  updateError?: unknown,
  failAudit = false,
) {
  const updates: string[] = [];
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    if (sql.includes("SELECT s.id, s.program_id")) return { rows: sessions };
    if (sql.includes("FROM payroll_transactions t")) return { rows: candidates };
    if (sql.includes("UPDATE scheduled_sessions") && sql.includes("RETURNING id")) {
      updates.push(sql);
      if (updateError) throw updateError;
      return { rows: [{ id: SESSION_ID }] };
    }
    if (sql.includes("INSERT INTO audit_logs") && failAudit) throw new Error("audit unavailable");
    return { rows: [] };
  });
  const client = { query: query as PgLikeClient["query"], release: vi.fn() } as PgLikeClient;
  return {
    pool: { query, connect: vi.fn(async () => client) } as unknown as PgLikePool,
    query,
    updates,
    statements,
    client,
  };
}

async function reconcileWith(candidate: typeof exactCandidate, planned: SessionFixture = session) {
  const mocked = poolFor([planned], [candidate]);
  const result = await autoReconcile(
    mocked.pool,
    { from: "2026-08-01", to: "2026-08-31" },
    null,
  );
  if (!result.ok) throw new Error(result.message);
  return { ...mocked, result: result.data };
}

describe("automatic schedule reconciliation safety", () => {
  it("backs the one-transaction invariant with a partial unique database index", () => {
    const migration = readFileSync("drizzle/0038_unique_schedule_transaction_match.sql", "utf8");
    expect(migration).toContain("CREATE UNIQUE INDEX");
    expect(migration).toContain('("matched_transaction_id")');
    expect(migration).toContain('WHERE "matched_transaction_id" IS NOT NULL');
  });

  it("matches only an exact one-day, same-employee, same-hours, one-to-one fact", async () => {
    const { result, updates, query } = await reconcileWith(exactCandidate);

    expect(result).toEqual({ matched: 1, considered: 1 });
    expect(updates).toHaveLength(1);
    const candidateSql = query.mock.calls.find(([sql]) => String(sql).includes("FROM payroll_transactions t"))?.[0];
    expect(candidateSql).toContain("t.period_begin = $3::date AND t.period_end = $3::date");
    expect(candidateSql).toContain("t.employee_id = $4");
    expect(candidateSql).toContain("t.imported_hours = $5::numeric");
    expect(candidateSql).toContain("t.is_group_service = false");
  });

  it("does not mutate for a pay-period aggregate", async () => {
    const { result, updates } = await reconcileWith({
      ...exactCandidate,
      period_begin: "2026-08-01",
      period_end: "2026-08-15",
    });
    expect(result.matched).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("does not mutate for a different employee", async () => {
    const { result, updates } = await reconcileWith({
      ...exactCandidate,
      employee_id: OTHER_EMPLOYEE_ID,
    });
    expect(result.matched).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("does not mutate when recorded hours differ", async () => {
    const { result, updates } = await reconcileWith({
      ...exactCandidate,
      imported_hours: "6.0000",
    });
    expect(result.matched).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("does not mutate group visits or group records", async () => {
    const plannedGroup = { ...session, is_group: true, group_size: 2 };
    const planned = await reconcileWith(exactCandidate, plannedGroup);
    const recorded = await reconcileWith({ ...exactCandidate, is_group_service: true });

    expect(planned.result.matched).toBe(0);
    expect(planned.updates).toHaveLength(0);
    expect(recorded.result.matched).toBe(0);
    expect(recorded.updates).toHaveLength(0);
  });

  it("does not mutate when more than one exact candidate exists", async () => {
    const mocked = poolFor([session], [
      exactCandidate,
      { ...exactCandidate, id: "00000000-0000-4000-8000-000000000007" },
    ]);
    const result = await autoReconcile(
      mocked.pool,
      { from: "2026-08-01", to: "2026-08-31" },
      null,
    );

    expect(result).toEqual({ ok: true, data: { matched: 0, considered: 1 } });
    expect(mocked.updates).toHaveLength(0);
  });

  it("counts only visits that are eligible for an exact match check", async () => {
    const mocked = poolFor([
      { ...session, employee_id: null },
      { ...session, id: SECOND_SESSION_ID, allocation_count: 2 },
    ], []);

    const result = await autoReconcile(
      mocked.pool,
      { from: "2026-08-01", to: "2026-08-31" },
      null,
    );

    expect(result).toEqual({ ok: true, data: { matched: 0, considered: 0 } });
    expect(mocked.query.mock.calls.some(([sql]) => String(sql).includes("FROM payroll_transactions t"))).toBe(false);
  });

  it("does not let one exact record claim two planned visits", async () => {
    const mocked = poolFor(
      [session, { ...session, id: SECOND_SESSION_ID }],
      [exactCandidate],
    );
    const result = await autoReconcile(
      mocked.pool,
      { from: "2026-08-01", to: "2026-08-31" },
      null,
    );

    expect(result).toEqual({ ok: true, data: { matched: 0, considered: 2 } });
    expect(mocked.updates).toHaveLength(0);
  });

  it("treats a concurrent database claim as an ordinary skipped match", async () => {
    const conflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "scheduled_sessions_one_transaction_match_key",
    });
    const mocked = poolFor([session], [exactCandidate], conflict);

    const result = await autoReconcile(
      mocked.pool,
      { from: "2026-08-01", to: "2026-08-31" },
      null,
    );

    expect(result).toEqual({ ok: true, data: { matched: 0, considered: 1 } });
    expect(mocked.updates).toHaveLength(1);
    expect(mocked.statements).toContain("ROLLBACK TO SAVEPOINT auto_match_candidate");
    expect(mocked.statements).toContain("COMMIT");
  });

  it("commits exact matches only after their aggregate audit succeeds", async () => {
    const mocked = poolFor([session], [exactCandidate]);

    await expect(autoReconcile(
      mocked.pool,
      { from: "2026-08-01", to: "2026-08-31" },
      null,
    )).resolves.toEqual({ ok: true, data: { matched: 1, considered: 1 } });

    const auditIndex = mocked.statements.findIndex((sql) => sql.includes("INSERT INTO audit_logs"));
    expect(auditIndex).toBeGreaterThan(mocked.statements.findIndex((sql) => sql.includes("UPDATE scheduled_sessions")));
    expect(auditIndex).toBeLessThan(mocked.statements.indexOf("COMMIT"));
    expect(mocked.client.release).toHaveBeenCalledOnce();
  });

  it("rolls every exact match back when its audit record cannot be written", async () => {
    const mocked = poolFor([session], [exactCandidate], undefined, true);

    await expect(autoReconcile(
      mocked.pool,
      { from: "2026-08-01", to: "2026-08-31" },
      null,
    )).rejects.toThrow("audit unavailable");

    expect(mocked.statements).toContain("ROLLBACK");
    expect(mocked.statements).not.toContain("COMMIT");
    expect(mocked.client.release).toHaveBeenCalledOnce();
  });
});
