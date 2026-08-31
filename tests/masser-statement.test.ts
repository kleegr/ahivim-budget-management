import { describe, expect, it, vi } from "vitest";
import { fullAccess } from "@/lib/auth/access";
import { getIndividualMasserStatement } from "@/lib/data/direct-pay-operations";
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
          period_start: "2026-01-01",
          period_end: "2027-01-01",
          approved_reserve: "1200",
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
      periodStart: "2026-01-01",
      periodEnd: "2027-01-01",
      approvedReserve: "1200.0000",
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
    expect(statementSql).toContain("o.period_begin <= requested.month_end");
    expect(statementSql).toContain("o.period_end > requested.month_end");
    expect(statementSql).toContain("selected_plan AS");
    expect(statementSql).toContain("LIMIT 1");
    expect(statementSql).not.toContain("requested.month_start >= date_trunc('month', o.period_begin)");
    expect(query.mock.calls.filter(([sql]) => sql.includes("settlement_")).every(([, params]) => (
      Array.isArray(params) && params[1] === "2026-08"
    ))).toBe(true);
    expect(statementSql).not.toContain("JOIN employees");
    expect(statementSql).not.toContain("employee_payroll_checks");
    expect(statementSql).not.toContain("payroll_transactions");
  });
});
