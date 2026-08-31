import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import {
  REPORTS,
  actualVsScheduledReport,
  programTotalsReport,
} from "@/lib/data/report-queries";
import { dec } from "@/lib/money";

describe("report activity truth", () => {
  it("reads actual-vs-scheduled actuals from committed transactions with the full scope", async () => {
    let sql = "";
    let params: unknown[] = [];
    const pool = {
      query: vi.fn(async (query: string, values?: unknown[]) => {
        sql = query;
        params = values ?? [];
        return {
          rows: [{
            individual_id: "00000000-0000-4000-8000-000000000001",
            individual_name: "Ari Cohen",
            program_code: "DAY_HAB",
            program_name: "Day Habilitation",
            scheduled_hours: "10",
            scheduled_internal: "170",
            actual_hours: "7",
            actual_internal: "119",
            hours_variance: "-3",
            internal_variance: "-51",
          }],
        };
      }),
    } as unknown as PgLikePool;

    const rows = await actualVsScheduledReport(pool, {
      from: "2026-01-01",
      to: "2026-01-31",
      individual: "Ari",
      employee: "Leah",
      program: "DAY",
    });

    expect(sql).toContain("FROM payroll_transactions t");
    expect(sql).not.toContain("FROM service_allocations");
    expect(sql).toContain("canonical_service_date(");
    expect(sql).toContain("s.session_date >= $1");
    expect(sql).toContain("actual_individual.display_name ILIKE");
    expect(sql).toContain("actual_employee.display_name ILIKE");
    expect(params).toEqual(["2026-01-01", "2026-01-31", "Ari", "Leah", "DAY"]);
    expect(dec(rows[0].actualHours).toNumber()).toBe(7);
    expect(dec(rows[0].actualInternal).toNumber()).toBe(119);
  });

  it("keeps credited individual hours separate from once-per-session employee hours", async () => {
    let sql = "";
    let params: unknown[] = [];
    const pool = {
      query: vi.fn(async (query: string, values?: unknown[]) => {
        sql = query;
        params = values ?? [];
        return {
          rows: [{
            program_id: "00000000-0000-4000-8000-000000000002",
            program_code: "DAY_HAB",
            program_name: "Day Habilitation",
            individuals_served: "3",
            employees: "1",
            credited_individual_hours: "30",
            physical_employee_hours: "17",
            agency_gross: "510",
            internal_amount: "450",
            agency_additional: "60",
            group_sessions: "1",
          }],
        };
      }),
    } as unknown as PgLikePool;

    const rows = await programTotalsReport(pool, {
      from: "2026-02-01",
      to: "2026-02-28",
    });

    expect(sql).toContain("credited_individual_hours");
    expect(sql).toContain("physical_sessions AS");
    expect(sql).toContain("'session:' || t.service_session_id::text");
    expect(sql).toContain("max(COALESCE(ss.physical_hours, t.imported_hours, 0))");
    expect(sql).toContain("count(*) FILTER (WHERE is_group)");
    expect(params).toEqual(["2026-02-01", "2026-02-28"]);
    expect(dec(rows[0].creditedIndividualHours).toNumber()).toBe(30);
    expect(dec(rows[0].physicalEmployeeHours).toNumber()).toBe(17);
  });

  it("publishes clear hour labels and usable date/person filters", async () => {
    expect(REPORTS["program-totals"].description).toContain("Credited hours repeat for each individual");
    expect(REPORTS["program-totals"].description).toContain("without a session link");
    expect(REPORTS["program-totals"].filters.map((filter) => filter.key)).toEqual(["from", "to"]);
    expect(REPORTS["actual-vs-scheduled"].filters.map((filter) => filter.key)).toEqual([
      "from",
      "to",
      "individual",
      "employee",
      "program",
    ]);

    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as PgLikePool;
    const [programTable] = await REPORTS["program-totals"].run(pool, {});
    expect(programTable.columns.map((column) => column.header)).toContain("Credited individual hours");
    expect(programTable.columns.map((column) => column.header)).toContain("Physical employee hours");
  });
});
