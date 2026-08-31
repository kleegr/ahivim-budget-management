import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fullAccess, type AccessScope } from "@/lib/auth/access";
import { listCurrentProgramBudgets } from "@/lib/data/program-budgets";
import type { PgLikePool } from "@/lib/import/commit";

const PERSON = "10000000-0000-4000-8000-000000000001";
const CONNECTED_PERSON = "10000000-0000-4000-8000-000000000002";

function currentRow(overrides: Record<string, unknown> = {}) {
  return {
    authorization_id: "20000000-0000-4000-8000-000000000001",
    budget_period_id: "30000000-0000-4000-8000-000000000001",
    individual_id: PERSON,
    individual_name: "Current Person",
    program_id: "40000000-0000-4000-8000-000000000001",
    program_code: "COM_HAB",
    program_name: "Com Hab",
    period_label: "Primary / 2026",
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    renewal_date: "2027-01-01",
    period_type: "rolling",
    period_status: "active",
    required_auth_type: "hours",
    service_category: "self_hire",
    payment_recipient: "employee",
    consumption_source: "payroll",
    rate_scope: "per_individual",
    renewal_policy: "individual",
    allow_individual_rate_override: true,
    authorized_hours: "100",
    authorized_dollars: null,
    internal_rate: "21",
    agency_rate: "25",
    individual_rate_override: null,
    notes: null,
    consumed_hours: "25",
    consumed_dollars: "625",
    remaining_hours: "75",
    remaining_dollars: null,
    scheduled_hours: "10",
    remaining_after_scheduled_hours: "65",
    undated_usage_count: 0,
    has_undated_usage: false,
    revision: 1,
    is_explicit: false,
    authorization_source: "calculation_strategy",
    source_candidate_count: 2,
    ...overrides,
  };
}

function scopedBudgetViewer(): AccessScope {
  return {
    ...fullAccess("viewer-1", "viewer"),
    full: false,
    allIndividuals: false,
    allEmployees: false,
    individualIds: [PERSON, CONNECTED_PERSON],
    grantedIndividualIds: [PERSON],
    employeeIds: [],
    grantedEmployeeIds: [],
  };
}

describe("shared current program budgets", () => {
  it("reads the Scheduling selector and keeps a strategy fallback visibly read-only", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [currentRow()] }));
    const rows = await listCurrentProgramBudgets(
      { query } as unknown as PgLikePool,
      { asOf: "2026-08-31" },
    );

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("effective_budget_authorizations_at($1::date)");
    expect(sql).toContain("effective_billed_hours(");
    expect(sql).not.toContain("payroll_usage.hours");
    expect(sql).toContain("LEFT JOIN program_budget_balances explicit_balance");
    expect(sql).toContain("canonical_service_date");
    expect(sql).toContain("effective.source_candidate_count");
    expect(sql).toContain("CASE WHEN explicit_balance.authorization_id IS NOT NULL\n                 THEN explicit_balance.renewal_date");
    expect(params).toEqual(["2026-08-31"]);
    expect(rows[0]).toMatchObject({
      authorizedHours: "100.0000",
      consumedHours: "25.0000",
      scheduledHours: "10.0000",
      remainingAfterScheduledHours: "65.0000",
      isExplicit: false,
      source: "calculation_strategy",
      sourceCandidateCount: 2,
    });
  });

  it("limits scoped budget reads to direct grants, never connected navigation people", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [currentRow()] }));
    await listCurrentProgramBudgets(
      { query } as unknown as PgLikePool,
      { asOf: "2026-08-31", scope: scopedBudgetViewer() },
    );

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("effective.individual_id = ANY($2::uuid[])");
    expect(params).toEqual(["2026-08-31", [PERSON]]);
    expect(params).not.toContainEqual([CONNECTED_PERSON]);
  });

  it("keeps full owner/admin reads unfiltered", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [currentRow({ is_explicit: true, source_candidate_count: 1 })],
    }));
    await listCurrentProgramBudgets(
      { query } as unknown as PgLikePool,
      { asOf: "2026-08-31", scope: fullAccess("admin-1", "admin") },
    );

    const [sql, params] = query.mock.calls[0]!;
    expect(sql).not.toContain("effective.individual_id = ANY");
    expect(params).toEqual(["2026-08-31"]);
  });

  it("defines explicit precedence and reduces duplicate strategy lines without summing", () => {
    const migration = readFileSync(
      new URL("../drizzle/0037_current_authorization_truth.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("PARTITION BY sp.individual_id, sp.program_id");
    expect(migration).toContain("ORDER BY sp.sort_order, sp.created_at, sp.strategy_id, sp.line_id");
    expect(migration).toContain("count(*) OVER");
    expect(migration).toContain("WHERE sr.source_rank = 1");
    expect(migration).toContain("FROM explicit_rows er");
    expect(migration).toContain("i.status = 'active'");
    expect(migration).toContain("i.archived_at IS NULL");
    expect(migration).toContain("i.merged_into_id IS NULL");
    expect(migration).toContain("p.is_active = true");
    expect(migration).toContain("p.archived_at IS NULL");
    expect(migration).toContain("p.renewal_policy = 'calendar'");
    expect(migration).toContain("sb.renewal_policy = 'calendar'");
    expect(migration).not.toContain("DAY_HAB");
    expect(migration).toContain("canonical_service_date(");
    expect(migration).toContain("rules.rate_scope = 'per_group'");
    expect(migration).toContain("FROM program_budget_events event");
  });

  it("keeps the People budget classification operational rather than financial", () => {
    const peoplePage = readFileSync(
      new URL("../src/app/(app)/individuals/page.tsx", import.meta.url),
      "utf8",
    );

    expect(peoplePage).toContain(
      'row.requiredAuthType === "hours" || row.requiredAuthType === "both"',
    );
    expect(peoplePage).not.toContain(
      'row.requiredAuthType !== "dollars" || scope.canSeeBilledAmounts',
    );
  });

  it("uses the shared current hour budgets on the non-owner home snapshot", () => {
    const dashboard = readFileSync(
      new URL("../src/app/(app)/dashboard/page.tsx", import.meta.url),
      "utf8",
    );

    expect(dashboard).toContain("listCurrentProgramBudgets(pool, { asOf: today, scope })");
    expect(dashboard).toContain(
      'row.requiredAuthType === "hours" || row.requiredAuthType === "both"',
    );
    expect(dashboard).toContain("scope.canSeeSettlements");
  });

  it("enforces the active operational cohort in the runtime read as well as the database selector", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    await listCurrentProgramBudgets(
      { query } as unknown as PgLikePool,
      { asOf: "2026-08-31" },
    );

    const sql = query.mock.calls[0]![0];
    expect(sql).toContain("individual.status = 'active'");
    expect(sql).toContain("individual.archived_at IS NULL");
    expect(sql).toContain("individual.merged_into_id IS NULL");
    expect(sql).toContain("program.is_active = true");
    expect(sql).toContain("program.archived_at IS NULL");
  });
});
