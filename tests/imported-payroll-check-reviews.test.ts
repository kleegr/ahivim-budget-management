import { describe, expect, it, vi } from "vitest";
import { syncImportedPayrollCheckReviews } from "@/lib/manage/direct-pay-operations";
import type { PgLikeClient, PgLikePool } from "@/lib/import/commit";

const BATCH_ID = "123e4567-e89b-12d3-a456-426614174000";

describe("imported payroll-check review sync", () => {
  it("creates only unverified direct-pay review facts and links exact source rows", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes("AS has_changes")) return { rows: [{ has_changes: true }] };
      if (sql.includes("INSERT INTO employee_payroll_checks")) return { rows: [{ id: "check-1" }] };
      if (sql.includes("UPDATE payroll_transactions t")) return { rows: [{ id: "tx-1" }, { id: "tx-2" }] };
      return { rows: [] };
    });
    const client = { query, release: vi.fn() } as unknown as PgLikeClient;
    const pool = { connect: vi.fn(async () => client), query } as unknown as PgLikePool;

    await expect(syncImportedPayrollCheckReviews(pool, BATCH_ID, null)).resolves.toEqual({
      checks: 1,
      linkedTransactions: 2,
    });

    const insert = statements.find((sql) => sql.includes("INSERT INTO employee_payroll_checks"));
    expect(insert).toContain("effective_payment_recipient");
    expect(insert).toContain("= 'employee'");
    expect(insert).toContain("count(DISTINCT t.total_net_pay) = 1");
    expect(insert).toContain("min(t.total_net_pay) >= 0");
    expect(insert).toContain("$1::uuid IS NULL AND t.import_batch_id IS NOT NULL");
    expect(insert).toContain("'unverified'");
    expect(insert).toContain("ON CONFLICT DO NOTHING");

    const link = statements.find((sql) => sql.includes("UPDATE payroll_transactions t"));
    expect(link).toContain("WITH target_identities AS");
    expect(link).toContain("count(DISTINCT source_row.total_net_pay) = 1");
    expect(link).toContain("min(source_row.total_net_pay) >= 0");
    expect(link).toContain("check_fact.actual_net = candidate.actual_net");
    expect(link).toContain("check_fact.verification_status <> 'void'");
    expect(link).toContain("source_row.total_net_pay IS NOT NULL");
    expect(link).toContain("t.payment_recipient");
    expect(link).toContain("= 'employee'");
    expect(link).not.toContain("t.total_net_pay = candidate.actual_net");
    expect(link).toContain("t.payroll_check_id IS NULL");
    expect(link).toContain("$1::uuid IS NULL AND t.import_batch_id IS NOT NULL");
    expect(statements).toContain("COMMIT");
  });

  it("can rebuild missing review facts across historical imports", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      return { rows: [] };
    });
    const client = { query, release: vi.fn() } as unknown as PgLikeClient;
    const pool = { connect: vi.fn(async () => client), query } as unknown as PgLikePool;

    await expect(syncImportedPayrollCheckReviews(pool, null, null)).resolves.toEqual({
      checks: 0,
      linkedTransactions: 0,
    });
    expect(statements.some((sql) => sql.includes("$1::uuid IS NULL AND t.import_batch_id IS NOT NULL"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO employee_payroll_checks"))).toBe(false);
    expect(statements.some((sql) => sql.includes("UPDATE payroll_transactions t"))).toBe(false);
  });
});
