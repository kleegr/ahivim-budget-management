import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import {
  REPORTS,
  individualPutAwayReport,
  payrollChecksReport,
} from "@/lib/data/report-queries";
import { REPORT_LIBRARY } from "@/components/reports/report-library";

const ledgerRow = {
  id: "00000000-0000-4000-8000-000000000001",
  service_date: "2026-07-10",
  pay_to: "Excellent Staffing",
  check_date: "2026-07-18",
  check_number: "CHK-42",
  hours: "3.5",
  rate: "100",
  gross: "350",
  total_net_pay: "280",
  period_begin: "2026-07-01",
  period_end: "2026-07-15",
  program: "Community Habilitation",
  program_code: "COMHAB",
  program_id: "00000000-0000-4000-8000-000000000002",
  individual: "Sample Individual",
  individual_id: "00000000-0000-4000-8000-000000000003",
  employee: "Sample Employee",
  employee_id: "00000000-0000-4000-8000-000000000004",
  internal_amount: "210",
  agency_additional: "140",
  payment_recipient: "excellent_staffing",
  import_batch_id: null,
  import_row_id: null,
  source_file_id: null,
  match_status: "new",
  is_group: false,
  service_session_id: null,
  group_detection_status: "single",
  is_paid: true,
  paid_at: "2026-07-20",
  paid_note: null,
};

describe("report release catalog", () => {
  it("publishes the two explicit business questions with their full filter contracts", () => {
    const catalog = REPORT_LIBRARY.flatMap((group) => group.reports);
    expect(catalog.find((report) => report.key === "payroll-checks")?.question).toContain("Which payroll rows");
    expect(catalog.find((report) => report.key === "individual-put-away")?.question).toContain("what remains");
    expect(REPORTS["payroll-checks"].filters.map((filter) => filter.key)).toEqual([
      "periodFrom", "periodTo", "checkDate", "checkNumber", "employee", "individual", "program", "recipient",
    ]);
    expect(REPORTS["individual-put-away"].filters.map((filter) => filter.key)).toEqual([
      "month", "individual", "status",
    ]);
  });

  it("filters the canonical transaction projection across payroll and person dimensions", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [ledgerRow] }),
    } as unknown as PgLikePool;

    await expect(payrollChecksReport(pool, {
      periodFrom: "2026-07-15",
      periodTo: "2026-07-31",
      checkDate: "2026-07-18",
      checkNumber: "42",
      employee: "employee",
      individual: "sample",
      program: "comhab",
      recipient: "excellent_staffing",
    })).resolves.toHaveLength(1);
    await expect(payrollChecksReport(pool, { checkNumber: "not-this-check" })).resolves.toEqual([]);
  });

  it("composes individual put-away from the Money-operations read model", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM individuals i") && sql.includes("approved_monthly_plan")) {
        return { rows: [{
          individual_id: "00000000-0000-4000-8000-000000000003",
          individual_name: "Sample Individual",
          approved_monthly_plan: "500",
          set_aside_this_month: "300",
          remaining_set_aside: "200",
          active_plans: "1",
          tracked_plans: "1",
          missing_renewal_plans: "0",
        }] };
      }
      return { rows: [] };
    });
    const pool = { query } as unknown as PgLikePool;

    const result = await individualPutAwayReport(pool, {
      month: "2026-08",
      individual: "sample",
      status: "outstanding",
    });

    expect(result).toEqual({
      month: "2026-08",
      setupHistoryAvailable: true,
      rows: [expect.objectContaining({
        individualName: "Sample Individual",
        approvedMonthlyPlan: "500.0000",
        setAsideThisMonth: "300.0000",
        remainingSetAside: "200.0000",
      })],
    });
    expect(query.mock.calls.some(([sql]) => sql.includes("calculation_metadata->>'flow' = 'individual_plan'"))).toBe(true);
  });

  it("marks pre-August setup values unavailable while retaining recorded ledger activity", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM individuals i") && sql.includes("approved_monthly_plan")) {
        return { rows: [{
          individual_id: "00000000-0000-4000-8000-000000000003",
          individual_name: "Sample Individual",
          approved_monthly_plan: "500",
          set_aside_this_month: "300",
          remaining_set_aside: "200",
          active_plans: "1",
          tracked_plans: "1",
          missing_renewal_plans: "0",
        }] };
      }
      return { rows: [] };
    });
    const pool = { query } as unknown as PgLikePool;

    const report = await individualPutAwayReport(pool, { month: "2026-07" });
    expect(report.setupHistoryAvailable).toBe(false);
    expect(report.rows[0]).toMatchObject({
      approvedMonthlyPlan: null,
      activePlans: null,
      missingRenewalPlans: null,
      setAsideThisMonth: "300.0000",
      remainingSetAside: "200.0000",
    });

    const [table] = await REPORTS["individual-put-away"].run(pool, { month: "2026-07" });
    expect(table.title).toContain("unavailable before August 2026");
    expect(table.rows[0]).toMatchObject({
      approvedMonthlyPlan: null,
      setupStatus: "Unavailable before Aug 2026",
    });
  });
});
