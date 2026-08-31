import { describe, expect, it, vi } from "vitest";
import { listProgramBudgetMonthlyHistory, listProgramBudgets } from "@/lib/data/program-budgets";
import type { PgLikePool } from "@/lib/import/commit";

const PERIOD = "10000000-0000-4000-8000-000000000001";
const PROGRAM = "20000000-0000-4000-8000-000000000001";

describe("canonical program budget monthly history", () => {
  it("returns pending schedule and the balance after that schedule", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [{
        authorization_id: "30000000-0000-4000-8000-000000000001",
        budget_period_id: PERIOD,
        individual_id: "40000000-0000-4000-8000-000000000001",
        individual_name: "Test Person",
        program_id: PROGRAM,
        program_code: "COM_HAB",
        program_name: "Com Hab",
        period_label: "Annual",
        start_date: "2026-01-01",
        end_date: "2027-01-01",
        renewal_date: "2027-01-01",
        period_type: "rolling",
        period_status: "active",
        required_auth_type: "hours",
        service_category: "support",
        payment_recipient: "agency",
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
        consumed_hours: "40",
        consumed_dollars: "1000",
        remaining_hours: "60",
        remaining_dollars: null,
        scheduled_hours: "15",
        remaining_after_scheduled_hours: "45",
        undated_usage_count: 0,
        has_undated_usage: false,
        revision: 1,
      }],
    }));
    const rows = await listProgramBudgets({ query } as unknown as PgLikePool, { individualId: "40000000-0000-4000-8000-000000000001" });

    const sql = query.mock.calls[0]![0] as string;
    expect(sql).toContain("scheduled_session.status = 'pending'");
    expect(sql).toContain("scheduled_session.matched_transaction_id IS NULL");
    expect(rows[0]).toMatchObject({
      consumedHours: "40.0000",
      remainingHours: "60.0000",
      scheduledHours: "15.0000",
      remainingAfterScheduledHours: "45.0000",
    });
  });

  it("combines transaction actuals and pending unmatched schedule into a cumulative pace", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [
        {
          month_start: "2026-01-01",
          effective_start: "2026-01-01",
          effective_end: "2026-01-31",
          authorized_hours: "100",
          used_hours: "10",
          scheduled_hours: "0",
        },
        {
          month_start: "2026-02-01",
          effective_start: "2026-02-01",
          effective_end: "2026-02-28",
          authorized_hours: "100",
          used_hours: "20",
          scheduled_hours: "5",
        },
      ],
    }));
    const rows = await listProgramBudgetMonthlyHistory(
      { query } as unknown as PgLikePool,
      PERIOD,
      PROGRAM,
      new Date("2026-02-15T12:00:00.000Z"),
    );

    const sql = query.mock.calls[0]![0] as string;
    expect(sql).toContain("canonical_service_date");
    expect(sql).toContain("account.rate_scope = 'per_group'");
    expect(sql).toContain("scheduled_session.status = 'pending'");
    expect(sql).toContain("scheduled_session.matched_transaction_id IS NULL");
    expect(rows[1]).toMatchObject({
      month: "2026-02",
      usedHours: "20.0000",
      scheduledHours: "5.0000",
      cumulativeUsedHours: "30.0000",
      cumulativeScheduledHours: "5.0000",
      remainingHours: "70.0000",
      remainingAfterScheduledHours: "65.0000",
    });
    expect(Number(rows[1]!.expectedUsedHours)).toBeCloseTo((46 / 59) * 100, 3);
    expect(Number(rows[1]!.paceVarianceHours)).toBeCloseTo(30 - ((46 / 59) * 100), 3);
  });
});
