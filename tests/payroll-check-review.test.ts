import { describe, expect, it, vi } from "vitest";
import { payrollCheckReviewFilters, payrollCheckVerificationNotice } from "@/lib/business/payroll-check-review";
import { fullAccess } from "@/lib/auth/access";
import { getPayrollCheckCounts, getPayrollCheckPage, listPayrollChecks } from "@/lib/data/direct-pay-operations";
import type { PgLikePool } from "@/lib/import/commit";

describe("payroll check review", () => {
  it("bounds URL filters and rejects invalid status/page input", () => {
    expect(payrollCheckReviewFilters({ search: "  check  ", status: "unverified", page: 3 }))
      .toEqual({ search: "check", status: "unverified", page: 3 });
    expect(payrollCheckReviewFilters({ status: "other", page: Infinity })).toEqual({ search: "", status: "all", page: 1 });
    expect(payrollCheckReviewFilters({ search: "x".repeat(300), page: -1 }).search).toHaveLength(250);
  });

  it("keeps the matching count and paginated list inside the same employee and literal search filters", async () => {
    const employeeId = "00000000-0000-4000-8000-000000000001";
    const scope = { ...fullAccess("owner", "admin"), full: false, allEmployees: false, grantedEmployeeIds: [employeeId] };
    const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as PgLikePool;
    const filters = { search: "CHECK_%", status: "verified" };
    await getPayrollCheckCounts(pool, scope, filters);
    await listPayrollChecks(pool, scope, 50, null, { ...filters, offset: 100 });
    const calls = vi.mocked(pool.query).mock.calls as unknown as Array<[string, unknown[]]>;
    for (const [sql, params] of calls) {
      expect(sql).toContain("c.employee_id = ANY($1::uuid[])");
      expect(sql).toContain("c.verification_status = $2::text");
      expect(sql).toContain("strpos(lower(e.display_name), lower($3::text))");
      expect(params.slice(0, 3)).toEqual([[employeeId], "verified", "CHECK_%"]);
      expect(sql).not.toContain("CHECK_%");
    }
    expect(calls[1]![0]).toContain("c.id DESC");
    expect(calls[1]![0]).toContain("LIMIT $4 OFFSET $5");
    expect(calls[1]![1].slice(3)).toEqual([50, 100]);
  });

  it("clamps an emptied final page and scopes the retained record separately from status filters", async () => {
    const id = "00000000-0000-4000-8000-000000000002";
    const employeeId = "00000000-0000-4000-8000-000000000001";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("AS total")) return { rows: [{ total: "49", unverified: "49" }] };
      if (sql.includes("c.id =")) return { rows: [{ id, employee_id: employeeId, employee_name: "Employee",
        actual_gross: "100", actual_net: "80", verification_status: "verified", linked_transactions: "0", transaction_ids: [] }] };
      return { rows: [] };
    });
    const scope = { ...fullAccess("owner", "admin"), full: false, allEmployees: false, grantedEmployeeIds: [employeeId] };
    const page = await getPayrollCheckPage({ query } as unknown as PgLikePool, scope,
      { page: 9, status: "unverified", retainedCheckId: id });
    expect(page).toMatchObject({ page: 1, total: 49, retainedCheck: { id, verificationStatus: "verified" } });
    const retainedSql = query.mock.calls.find(([sql]) => sql.includes("c.id ="))![0];
    expect(retainedSql).toContain("c.employee_id = ANY($1::uuid[])");
    expect(retainedSql).not.toContain("c.verification_status =");
  });

  it("does not query checks or matching counts without any check detail permission", async () => {
    const pool = { query: vi.fn() } as unknown as PgLikePool;
    const scope = { ...fullAccess("owner", "admin"), canSeeCheckGross: false, canSeeCheckNet: false, canSeeTaxes: false };
    expect(await getPayrollCheckPage(pool, scope, { search: "secret", retainedCheckId: "00000000-0000-4000-8000-000000000002" }))
      .toMatchObject({ rows: [], total: 0, retainedCheck: null });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("reports verified facts without claiming a collection when no services linked", () => {
    expect(payrollCheckVerificationNotice({ linkedTransactions: 0 })).toMatchObject({ tone: "warning", needsSourceReview: true });
    expect(payrollCheckVerificationNotice({ linkedTransactions: 0 }).message).toContain("No linked services were found");
    expect(payrollCheckVerificationNotice({ linkedTransactions: 0 }).message).toContain("no collection amount was created");
    expect(payrollCheckVerificationNotice({ linkedTransactions: 2 }).message).toContain("2 linked services");
    expect(payrollCheckVerificationNotice({ linkedTransactions: 2 }).message).not.toContain("collection amount calculated");
    expect(payrollCheckVerificationNotice({ linkedTransactions: 1, settlementWarning: "Refresh unavailable" }))
      .toMatchObject({ tone: "warning", needsSourceReview: false, message: expect.stringContaining("Check facts verified with 1 linked service.") });
    expect(payrollCheckVerificationNotice({ settlementWarning: "Refresh unavailable" }).message).toContain("Refresh unavailable");
  });
});
