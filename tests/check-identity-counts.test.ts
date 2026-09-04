import { describe, expect, it, vi } from "vitest";
import type { PgLikePool } from "@/lib/import/commit";
import {
  getEmployeeMonthlyPayments,
  getEmployeePaymentSummary,
} from "@/lib/data/employee-queries";
import { employeePayableReport } from "@/lib/data/report-queries";

const EMPLOYEE_ID = "00000000-0000-4000-8000-000000000001";

function expectCompleteCheckIdentityCount(sql: string): void {
  expect(sql).toMatch(/count\(DISTINCT ROW\(\s*t\.employee_id,/);
  expect(sql).toContain("COALESCE(NULLIF(btrim(t.check_number), ''), '')");
  expect(sql).toContain("COALESCE(t.check_date, 'infinity'::date)");
  expect(sql).toContain("COALESCE(t.period_begin, 'infinity'::date)");
  expect(sql).toContain("COALESCE(t.period_end, 'infinity'::date)");
  expect(sql).toContain("NULLIF(btrim(t.check_number), '') IS NOT NULL");
  expect(sql).toContain("OR t.check_date IS NOT NULL");
  expect(sql).toContain("OR t.period_begin IS NOT NULL");
  expect(sql).toContain("OR t.period_end IS NOT NULL");
  expect(sql).not.toContain("count(DISTINCT t.check_number)");
}

describe("complete payroll-check identity counts", () => {
  it("uses employee, normalized number, and all three dates in every check aggregate", async () => {
    const captured: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        captured.push(sql);
        if (sql.includes("GROUP BY 1")) return { rows: [] };
        if (sql.includes("FROM employees e")) return { rows: [] };
        return { rows: [{}] };
      }),
    } as unknown as PgLikePool;

    await getEmployeePaymentSummary(pool, EMPLOYEE_ID);
    await getEmployeeMonthlyPayments(pool, EMPLOYEE_ID);
    await employeePayableReport(pool);

    expect(captured).toHaveLength(3);
    captured.forEach(expectCompleteCheckIdentityCount);
  });
});
