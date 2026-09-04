import { describe, expect, it, vi } from "vitest";
import { fullAccess } from "@/lib/auth/access";
import { getCollectionsWorkspace, getIndividualMasserStatement } from "@/lib/data/direct-pay-operations";
import type { PgLikePool } from "@/lib/import/commit";

const INDIVIDUAL_ID = "123e4567-e89b-12d3-a456-426614174000";

describe("individual Masser statement", () => {
  it("returns only aggregate individual reserve facts and monthly history", async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("FROM individuals i")) {
        return { rows: [{ id: INDIVIDUAL_ID, display_name: "Example Individual" }] };
      }
      if (sql.includes("current_balances AS")) {
        return { rows: [{
          approved_monthly_plan: "1200",
          active_plans: "2",
          tracked_plans: "1",
          missing_renewal_plans: "1",
          recorded_reserve: "350",
          remaining_reserve: "850",
          available_credit: "25",
        }] };
      }
      if (sql.includes("FROM settlement_events event")) {
        return { rows: [
          { month: "2026-08", set_aside: "250", corrections: "75", reversals: "50" },
          { month: "2026-07", set_aside: "100", corrections: "0", reversals: "0" },
        ] };
      }
      return { rows: [] };
    });
    const pool = { query } as unknown as PgLikePool;

    await expect(getIndividualMasserStatement(
      pool,
      fullAccess("owner", "admin"),
      INDIVIDUAL_ID,
      "2026-08",
    )).resolves.toEqual({
      individualId: INDIVIDUAL_ID,
      individualName: "Example Individual",
      setupHistoryAvailable: true,
      approvedMonthlyPlan: "1200.0000",
      activePlans: 2,
      trackedPlans: 1,
      missingRenewalPlans: 1,
      recordedReserve: "350.0000",
      remainingReserve: "850.0000",
      availableCredit: "25.0000",
      history: [
        { month: "2026-08", setAside: "250.0000", corrections: "75.0000", reversals: "50.0000" },
        { month: "2026-07", setAside: "100.0000", corrections: "0.0000", reversals: "0.0000" },
      ],
    });

    const statementSql = query.mock.calls.map(([sql]) => sql).join("\n");
    expect(statementSql).toContain("AS month_end");
    expect(statementSql).toContain("strategy_state_candidates AS");
    expect(statementSql).toContain("calculation_strategy_revisions");
    expect(statementSql).toContain("sum(abs(state.after_all))");
    expect(statementSql).toContain("state.after_all IS NOT NULL");
    expect(statementSql).toContain("state.status = 'active'");
    expect(statementSql).toContain("requested.month_end_exclusive >= DATE '2026-09-01'");
    expect(statementSql).toContain("candidate.effective_from < (requested.month_end_exclusive AT TIME ZONE 'America/New_York')");
    expect(statementSql).toContain("o.period_begin <= requested.month_end");
    expect(statementSql).toContain("o.period_end > requested.month_end");
    expect(statementSql).toContain("selected_plans AS");
    expect(statementSql).toContain("DISTINCT ON (calculation_strategy_id)");
    expect(statementSql).not.toContain("selected_plan AS");
    expect(statementSql).not.toContain("requested.month_start >= date_trunc('month', o.period_begin)");
    expect(query.mock.calls.filter(([sql]) => sql.includes("settlement_")).every(([, params]) => (
      Array.isArray(params) && params[1] === "2026-08"
    ))).toBe(true);
    expect(statementSql).not.toContain("JOIN employees");
    expect(statementSql).not.toContain("employee_payroll_checks");
    expect(statementSql).not.toContain("payroll_transactions");
  });

  it("sums every active approved final even when a setup has no renewal date", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("strategy_plans AS")) {
        return { rows: [{
          individual_id: INDIVIDUAL_ID,
          individual_name: "Example Individual",
          approved_monthly_plan: "33930",
          set_aside_this_month: "1200",
          remaining_set_aside: "850",
          active_plans: "3",
          tracked_plans: "2",
          missing_renewal_plans: "1",
        }] };
      }
      return { rows: [] };
    });
    const pool = { query } as unknown as PgLikePool;

    const workspace = await getCollectionsWorkspace(
      pool,
      fullAccess("owner", "admin"),
      "2026-08",
    );

    expect(workspace.summary.approvedMonthlySetAside).toBe("33930.0000");
    expect(workspace.setupHistoryAvailable).toBe(true);
    expect(workspace.individualSetAsides).toEqual([{
      individualId: INDIVIDUAL_ID,
      individualName: "Example Individual",
      approvedMonthlyPlan: "33930.0000",
      setAsideThisMonth: "1200.0000",
      remainingSetAside: "850.0000",
      activePlans: 3,
      trackedPlans: 2,
      missingRenewalPlans: 1,
    }]);

    const boardSql = query.mock.calls.map(([sql]) => sql).find((sql) => sql.includes("strategy_plans AS"))!;
    expect(boardSql).toContain("strategy_state_candidates AS");
    expect(boardSql).toContain("calculation_strategy_revisions");
    expect(boardSql).toContain("sum(abs(state.after_all))");
    expect(boardSql).toContain("state.status = 'active'");
    expect(boardSql).toContain("state.after_all IS NOT NULL");
    expect(boardSql).toContain("DISTINCT ON (individual_id, calculation_strategy_id)");
    expect(boardSql).toContain("state.renewal_date IS NULL");
  });

  it("does not borrow today's setup for months before reliable revision history", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const pool = { query } as unknown as PgLikePool;

    const workspace = await getCollectionsWorkspace(
      pool,
      fullAccess("owner", "admin"),
      "2026-07",
    );

    expect(workspace.setupHistoryAvailable).toBe(false);
    const boardSql = query.mock.calls.map(([sql]) => sql).find((sql) => sql.includes("strategy_plans AS"))!;
    expect(boardSql).toContain("requested.month_end_exclusive >= DATE '2026-09-01'");
  });
});
