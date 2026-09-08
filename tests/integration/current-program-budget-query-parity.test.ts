import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fullAccess } from "@/lib/auth/access";
import { listCurrentProgramBudgets, type CurrentProgramBudgetFilters } from "@/lib/data/program-budgets";
import type { PgLikePool } from "@/lib/import/commit";
import { closeTestPool, hasTestDatabase, resetSchema, testPool, truncateBusinessTables } from "../support/database";

const suite = hasTestDatabase ? describe : describe.skip;
const AS_OF = "2026-09-08";
let pool: PgLikePool;
let personId: string;
let periodId: string;
let programId: string;
let dollarsId: string;

suite("Current program budget shared-read parity (PostgreSQL)", () => {
  beforeAll(async () => {
    await resetSchema();
    await truncateBusinessTables();
    pool = testPool();
    programId = (await pool.query<{ id: string }>(
      `INSERT INTO programs (code, name, required_auth_type, consumption_source)
       VALUES ('READ_PARITY', 'Synthetic fractional service', 'both', 'mixed') RETURNING id`,
    )).rows[0]!.id;
    dollarsId = (await pool.query<{ id: string }>(
      `INSERT INTO programs (code, name, required_auth_type, consumption_source)
       VALUES ('READ_DOLLARS', 'Synthetic manual allowance', 'dollars', 'manual') RETURNING id`,
    )).rows[0]!.id;
    await pool.query(`INSERT INTO individuals (display_name, normalized_name)
      SELECT 'Read person ' || lpad(n::text, 2, '0'), 'read person ' || n FROM generate_series(1, 32) n`);
    await pool.query(`INSERT INTO budget_periods (individual_id, label, start_date, end_date, renewal_date, period_type)
      SELECT id, 'Current synthetic approval', '2026-01-01', '2026-12-31', '2027-01-01', 'calendar' FROM individuals`);
    await pool.query(`INSERT INTO budget_authorizations
      (budget_period_id, individual_id, program_id, authorized_hours, authorized_dollars,
       internal_rate, agency_rate, individual_rate_override, notes, revision, source)
      SELECT bp.id, bp.individual_id, $1, 100.0000, 1000.0001, 10.1234, 12.5678,
             0, 'Exact zero override retained', 3, 'synthetic_approval' FROM budget_periods bp`, [programId]);
    await pool.query(`INSERT INTO payroll_transactions
      (individual_id, program_id, period_begin, imported_hours, imported_amount,
       spreadsheet_internal_amount, transaction_fingerprint, is_paid, paid_note)
      SELECT id, $1, '2026-08-10', 2.2501, 26.0001, 22.1234, 'read-parity:' || id, true,
             'Existing application-owned fact' FROM individuals`, [programId]);
    await pool.query(`INSERT INTO program_budget_events
      (budget_period_id, individual_id, program_id, event_type, service_date, hours, amount, source_type, source_id)
      SELECT id, individual_id, $1::uuid, 'adjust', '2026-08-11'::date, 0.5001, 3.0001, 'read_parity', 'plus:' || id FROM budget_periods
      UNION ALL SELECT id, individual_id, $1::uuid, 'adjust', '2026-08-12'::date, -0.1001, -0.5001, 'read_parity', 'minus:' || id FROM budget_periods`, [programId]);
    const first = (await pool.query<{ person_id: string; period_id: string }>(
      `SELECT i.id AS person_id, bp.id AS period_id FROM individuals i
       JOIN budget_periods bp ON bp.individual_id = i.id ORDER BY i.display_name LIMIT 1`,
    )).rows[0]!;
    personId = first.person_id; periodId = first.period_id;
    await pool.query(`INSERT INTO payroll_transactions
      (individual_id, program_id, imported_hours, imported_amount, transaction_fingerprint)
      VALUES ($1, $2, 7.7777, 77.7777, 'read-parity:undated')`, [personId, programId]);
    await pool.query(`WITH session AS (
      INSERT INTO scheduled_sessions (program_id, session_date, duration_hours)
      VALUES ($1, '2026-09-15', 1.1250) RETURNING id
    ) INSERT INTO scheduled_allocations (scheduled_session_id, individual_id, allocation_hours)
      SELECT id, $2, 1.1250 FROM session`, [programId, personId]);
    await pool.query(`INSERT INTO budget_authorizations
      (budget_period_id, individual_id, program_id, authorized_hours, authorized_dollars, internal_rate)
      VALUES ($1, $2, $3, 0, 200.1250, 0)`, [periodId, personId, dollarsId]);
    await pool.query(`INSERT INTO program_budget_events
      (budget_period_id, individual_id, program_id, event_type, service_date, amount, source_type, source_id)
      VALUES ($1, $2, $3, 'consume', '2026-08-13', 10.1251, 'read_parity', 'dollars')`, [periodId, personId, dollarsId]);
    await pool.query(`WITH history AS (
      INSERT INTO budget_periods (individual_id, label, start_date, end_date, period_type, status)
      VALUES ($1, 'Unchanged ended history', '2025-01-01', '2025-12-31', 'calendar', 'closed') RETURNING id
    ) INSERT INTO budget_authorizations (budget_period_id, individual_id, program_id, authorized_hours, internal_rate)
      SELECT id, $1, $2, 999.9999, 1 FROM history`, [personId, programId]);
    await pool.query(`WITH fallback AS (
      INSERT INTO individuals (display_name, normalized_name) VALUES ('Fallback person', 'fallback person') RETURNING id
    ), strategies AS (
      INSERT INTO calculation_strategies (individual_id, label, renewal_date, sort_order)
      SELECT id, 'Fallback ' || n, '2027-01-01', n FROM fallback CROSS JOIN generate_series(0, 1) n RETURNING id, sort_order
    ) INSERT INTO calculation_strategy_lines (strategy_id, program_id, authorized_hours, rate_override)
      SELECT id, $1, CASE WHEN sort_order = 0 THEN 80.1250 ELSE 999 END, 0 FROM strategies`, [programId]);
  }, 60_000);
  afterAll(closeTestPool);

  async function controls(queryable: Pick<PgLikePool, "query">) {
    const tables = ["payroll_transactions", "budget_periods", "budget_authorizations", "program_budget_events", "audit_logs"];
    const result = [];
    for (const table of tables) result.push((await queryable.query(
      `SELECT count(*)::int AS count, md5(COALESCE(string_agg(row_hash, '' ORDER BY row_hash), '')) AS hash
       FROM (SELECT md5(to_jsonb(t)::text) AS row_hash FROM ${table} t) hashes`,
    )).rows[0]);
    return result;
  }

  it("retains every ordered field, exact decimal, fallback and direct scope without changing source controls", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const before = await controls(client);
      const snapshot: PgLikePool = {
        query: client.query.bind(client),
        connect: async () => { throw new Error("The read must reuse its existing read-only snapshot"); },
      };
      // NOT MATERIALIZED executes the same projection with the old inlined
      // balance behavior. Compare every field in one immutable database snapshot.
      const inlined = {
        query: (sql: string, args?: unknown[]) => client.query(
          sql.replace("explicit_balances AS MATERIALIZED", "explicit_balances AS NOT MATERIALIZED"), args,
        ),
      } as PgLikePool;
      const scope = { ...fullAccess(personId, "viewer"), full: false, allIndividuals: false,
        individualIds: [personId], grantedIndividualIds: [personId], allEmployees: false };
      const selections: CurrentProgramBudgetFilters[] = [
        { asOf: AS_OF }, { asOf: AS_OF, individualId: personId },
        { asOf: AS_OF, programId: dollarsId }, { asOf: AS_OF, scope },
      ];
      for (const filter of selections) {
        expect(await listCurrentProgramBudgets(snapshot, filter))
          .toEqual(await listCurrentProgramBudgets(inlined, filter));
      }
      const rows = await listCurrentProgramBudgets(snapshot, { asOf: AS_OF });
      expect(rows).toHaveLength(34);
      expect(rows[0]).toMatchObject({ individualName: "Fallback person", isExplicit: false,
        sourceCandidateCount: 2, authorizedHours: "80.1250", internalRate: "0.0000", authorizedDollars: null });
      expect(rows.find((row) => row.individualId === personId && row.programId === programId)).toMatchObject({
        isExplicit: true, consumedHours: "2.6501", consumedDollars: "28.5001", remainingHours: "97.3499",
        scheduledHours: "1.1250", remainingAfterScheduledHours: "96.2249", undatedUsageCount: 1,
        hasUndatedUsage: true, individualRateOverride: "0.0000", revision: 3, source: "synthetic_approval",
      });
      expect(rows.find((row) => row.programId === dollarsId)).toMatchObject({
        consumedHours: "0.0000", consumedDollars: "10.1251", remainingDollars: "189.9999", scheduledHours: "0.0000",
      });
      expect(await listCurrentProgramBudgets(snapshot, { asOf: AS_OF, scope }))
        .toEqual(rows.filter((row) => row.individualId === personId));
      expect(await controls(client)).toEqual(before);
    } finally { await client.query("ROLLBACK"); client.release(); }
  }, 60_000);

  it("executes the shared balance aggregate once across many current authorizations", async () => {
    let sql = ""; let args: unknown[] = [];
    await listCurrentProgramBudgets({ query: async (text: string, values: unknown[]) => {
      sql = text; args = values; return { rows: [] };
    } } as unknown as PgLikePool, { asOf: AS_OF });
    const result = await pool.query<{ "QUERY PLAN": { Plan: Record<string, unknown> }[] }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, args,
    );
    const nodes: Record<string, unknown>[] = [];
    const visit = (node: Record<string, unknown>) => {
      nodes.push(node);
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
    };
    visit(result.rows[0]!["QUERY PLAN"][0]!.Plan);
    // An executed-plan assertion catches the repeated-read regression without a
    // fragile wall-clock threshold that depends on CI machine speed.
    const shared = nodes.find((node) => node["Subplan Name"] === "CTE explicit_balances");
    expect(shared).toBeDefined();
    expect(shared!["Actual Loops"]).toBe(1);
    expect(Number(shared!["Actual Rows"])).toBeGreaterThanOrEqual(33);
    expect(result.rows[0]!["QUERY PLAN"][0]!.Plan["Actual Rows"]).toBe(34);
  });
});
