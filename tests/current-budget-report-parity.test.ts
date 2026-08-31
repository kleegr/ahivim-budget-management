import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  budgetUtilizationReport,
  dashboardReportMetrics,
  expiringAuthorizationsReport,
  missingConfigReport,
  utilizationOutliersReport,
} from "@/lib/data/report-queries";
import type { PgLikePool } from "@/lib/import/commit";

const PERSON = "10000000-0000-4000-8000-000000000001";
const DOLLAR_PERSON = "10000000-0000-4000-8000-000000000002";

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
    consumed_hours: "20",
    consumed_dollars: "500",
    remaining_hours: "80",
    remaining_dollars: null,
    scheduled_hours: "5",
    remaining_after_scheduled_hours: "75",
    undated_usage_count: 0,
    has_undated_usage: false,
    revision: 1,
    is_explicit: false,
    authorization_source: "calculation_strategy",
    source_candidate_count: 2,
    ...overrides,
  };
}

function reportPool() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("effective_budget_authorizations_at($1::date)")) {
      return {
        rows: [
          currentRow(),
          currentRow({
            authorization_id: "20000000-0000-4000-8000-000000000002",
            budget_period_id: "30000000-0000-4000-8000-000000000002",
            individual_id: DOLLAR_PERSON,
            individual_name: "Class Person",
            program_id: "40000000-0000-4000-8000-000000000002",
            program_code: "CLASSES",
            program_name: "Classes",
            required_auth_type: "dollars",
            authorized_hours: "0",
            authorized_dollars: "10000",
            consumed_hours: "0",
            consumed_dollars: "2000",
            remaining_hours: "0",
            remaining_dollars: "8000",
            scheduled_hours: "0",
            remaining_after_scheduled_hours: "0",
            is_explicit: true,
            authorization_source: "explicit_authorization",
            source_candidate_count: 1,
          }),
        ],
      };
    }
    if (sql.includes("i.id = ANY($1::uuid[])")) {
      return {
        rows: [{
          individual_id: PERSON,
          individual_name: "Current Person",
          has_assignment: false,
        }],
      };
    }
    if (sql.includes("AS transaction_rows")) {
      return {
        rows: [{
          agency_additional: "50",
          agency_additional_rows: "1",
          employee_payable: "450",
          employee_payable_rows: "1",
          transaction_rows: "1",
          unbilled_schedules: "2",
          unscheduled_billing: "3",
        }],
      };
    }
    return { rows: [] };
  });
  return { query } as unknown as PgLikePool;
}

describe("current authorization report parity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T16:00:00.000Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("includes the strategy fallback in utilization, outlier, and expiry reports", async () => {
    const pool = reportPool();
    const utilization = await budgetUtilizationReport(pool, { asOf: "2026-08-31" });
    const outliers = await utilizationOutliersReport(pool, { asOf: "2026-08-31" });
    const expiring = await expiringAuthorizationsReport(pool, {
      asOf: "2026-11-15",
      withinDays: 60,
    });
    const dueToday = await expiringAuthorizationsReport(pool, {
      asOf: "2026-12-31",
      withinDays: 60,
    });

    expect(utilization).toHaveLength(1);
    expect(utilization[0]).toMatchObject({
      individualId: PERSON,
      usedHours: "20.0000",
      scheduledHours: "5.0000",
    });
    expect(outliers).toEqual([
      expect.objectContaining({ individualId: PERSON, flag: "underutilizing" }),
    ]);
    expect(expiring).toContainEqual(expect.objectContaining({
      individualId: PERSON,
      daysRemaining: 46,
    }));
    expect(dueToday).toContainEqual(expect.objectContaining({
      individualId: PERSON,
      daysRemaining: 0,
    }));
  });

  it("keeps dollar-only allowances out of operational assignment and dashboard counts", async () => {
    const pool = reportPool();
    const missing = await missingConfigReport(pool);
    const metrics = await dashboardReportMetrics(pool);

    expect(missing.missingAssignments).toEqual([{
      individualId: PERSON,
      individualName: "Current Person",
      programsAuthorized: "COM_HAB",
    }]);
    expect(metrics).toMatchObject({
      agencyAdditional: { amount: "50.0000", available: true },
      employeePayable: { amount: "450.0000", available: true },
      counts: {
        nearExhaustion: 0,
        underutilizing: 1,
        expiringAuthorizations: 0,
        unbilledSchedules: 2,
        unscheduledBilling: 3,
        missingRates: 0,
        missingAssignments: 1,
      },
    });
  });
});
